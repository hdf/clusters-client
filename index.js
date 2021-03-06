#!/usr/bin/env node

var os = require('os'),
    fs = require('fs'),
    https = require('https'),
    url = require('url'),
    zlib = require('zlib'),
    Worker = require('webworker-threads').Worker;

var tty = (typeof process.stdout.clearLine == 'function'),
    host = 'localhost', port = 8082, prefix = '',
    cores = os.cpus().length || 1, start, time,
    workers = [], proc = '', inputData = [], packages = 0, last_dll = false,
    completed = 0, max = 0, // For progress meter
    c = 1, // Partition data for workers (dynamic scheduling)
    staticScheduling; // This is a switch (for the c above)!

//{ Command Line parameter parsing
var ca = process.argv.indexOf('-ca');
if (ca != -1) {
  process.argv.splice(ca, 1);
  ca = true;
} else
  ca = false;
if (process.argv.length > 2) {
  if (process.argv[2].substr(0, 7) == 'http://')
    process.argv[2] = process.argv[2].substr(7);
  if (process.argv[2].substr(0, 8) == 'https://')
    process.argv[2] = process.argv[2].substr(8);
  (function(){
    var tmp_url = url.parse('https://' + process.argv[2]);
    tmp_url.port = tmp_url.port || '443';
    while (tmp_url.pathname.substr(-1) == '/')
      tmp_url.pathname = tmp_url.pathname.substr(0, tmp_url.pathname.length - 1);
    host = tmp_url.hostname;
    port = parseInt(tmp_url.port);
    prefix = tmp_url.pathname;
  })()
}
if (process.argv.length > 3)
  cores = parseInt(process.argv[3]) || cores;
var caPath = __dirname + '/cas/' + host + '.crt';

var arch = process.platform;
//if (arch.substr(-2) == '32') arch = arch.slice(0, -2);
arch += '_' + process.arch.substr(-2);
//}

//{ Cert acquisition / loading
if (!fs.existsSync(__dirname + '/cas'))
  fs.mkdirSync(__dirname + '/cas');
if (ca) {
  connect(function(res) {
    res.setEncoding('utf8');
    var resdata = '';
    res.on('data', function(chunk) {
      resdata += chunk;
    });
    res.once('end', function() {
      ca = resdata;
      if (!fs.existsSync(caPath)) {
        fs.writeFileSync(caPath, ca);
        getPackage();
      } else {
        console.warn('A cert already exists for this host in the ca store!\n(Careful, someone might be trying to pose as the host!)');
        process.exit();
      }
    });
  }, prefix + '/ca', 'GET', undefined, '', true);
} else
  ca = (fs.existsSync(caPath))?fs.readFileSync(caPath):undefined;
//}

console.log('Connecting to package manager server at: \'' + host + '\' on port: ' + port + ' at path: \'' + prefix + '/\' using ' + cores + ' cores.');

//{ Spawn workers
function startWorkers() {
  stopWorkers();
  if (proc.length < 12) {
    console.error('No processing function specified!');
    return;
  }
  var code = new Function('var proc=' + proc + ';\n' + func.toString() + 'func();');
  for (var i = 0; i < cores; i++) {
    workers[i] = new Worker(code);
    workers[i].onmessage = gotResult;
    workers[i].postMessage({id: i}); // Assign worker an id
  }
}

function stopWorkers() {
  for (var i = 0, n = workers.length; i < n; i++)
    workers[i].terminate();
  workers = [];
}
//}

if (tty) {
  var idling = 0;
  setInterval(function() { // Running workers display
    process.stdout.moveCursor(0, 1);
    process.stdout.clearScreenDown();
    if (workers.length < 1 && inputData.length < 1) {
      idling = (idling + 1) % 4;
      var dots = new Array(idling + 1).join('.');
      process.stdout.write('Idling' + dots);
      process.stdout.cursorTo(0);
      process.stdout.moveCursor(0, -1);
      return;
    }
    process.stdout.write('Running Workers: ' + workers.length +
                         '\nRemaining jobs: ' + inputData.length +
                         '\nCompleted: ' + (Math.round((completed / max) * 10000) / 100) + '%');
    process.stdout.cursorTo(0);
    process.stdout.moveCursor(0, -3);
  }, 250);
  process.on('SIGINT', function() {
    process.stdout.moveCursor(0, 1);
    process.stdout.clearScreenDown();
    process.exit();
  });
}

//{ Server communications
var pkgId = '';
var getPackageTimer;

function ajax(url, data, cb) {
  url = prefix + '/' + url;
  cb = cb || function(){};
  data = JSON.stringify(data);
  var headers = {"Content-Type": 'application/json'};
  if (data.length > 1024) { // Compress if bigger than 1K
    headers['Content-Encoding'] = 'gzip';
    data = zlib.gzipSync(data);
  }
  connect(function(res) {
    if (url.substr(-3) == 'dll')
      res.setEncoding('binary');
    else
      res.setEncoding('utf8');
    var resdata = '';
    res.on('data', function(chunk) {
      resdata += chunk;
    });
    res.once('end', function() {
      cb(resdata);
    });
  }, url, 'POST', headers, data);
}

function getPackage() {
  if (tty) {
    process.stdout.clearLine();
    process.stdout.write('Getting new package...');
    process.stdout.cursorTo(0);
  }
  ajax('get', {packageId: pkgId, arch: arch}, function(res) {
    gotPackage(JSON.parse(res));
  });
}

function gotPackage(pkg) {
  if (tty) process.stdout.clearLine();
  if (getPackageTimer) clearTimeout(getPackageTimer);
  if (typeof pkg.packageId == 'undefined') { // If there are no more packages to process, check again in a minute
    stopWorkers();
    if (tty) {
      process.stdout.write('No new packages available, checking again in one minute.');
      process.stdout.cursorTo(0);
    }
    if (last_dll) { // Ugly hack, I know, but serverside the prioritization is a bit dicky, and I'm tired of it...
      getPackageTimer = setTimeout(getPackage, 800);
      last_dll = false;
    } else
      getPackageTimer = setTimeout(getPackage, 60000);
    return;
  }
  if (tty) {
    process.stdout.write('Got new ' + ((typeof(pkg.dll) === 'string')?'DLL ':'') + 'package (' + packages + '). Processing...');
    process.stdout.cursorTo(0);
  }
  pkgId = pkg.packageId;
  inputData = pkg.data;
  max = inputData.length;
  if (typeof pkg.func == 'string')
    proc = pkg.func;
  var tmp = [];
  for (var i = 0, n = inputData.length; i < n; i++) // Assign an index to each value (faster than map)
    tmp[i] = [i, inputData[i]];
  inputData = tmp;
  if (typeof(pkg.dll) === 'string') {
    staticScheduling = true;
    getDLL(pkg.packageId.split('_')[0], pkg.dll);
    last_dll = true;
  } else {
    staticScheduling = false;
    doWork();
    last_dll = false;
  }
}

function getDLL(proj, dllName) {
  ajax('dll', {proj: proj, arch: arch}, function(res) {
    var dllPath = os.tmpdir() + '/clusters-client';
    if (!fs.existsSync(dllPath)) fs.mkdirSync(dllPath);
    dllPath += '/' + proj;
    if (!fs.existsSync(dllPath)) fs.mkdirSync(dllPath);
    dllPath += '/' + dllName;
    fs.writeFile(dllPath, res, 'binary', function(err) {
      if (err) throw err;
      doDLL(dllPath);
    });
  });
}

function sendResults() {
  packages++;
  time = process.hrtime(start);
  console.log('Package \'' + pkgId + '\' containing ' + results.length +
              ' elements processed in ' + (Math.round((time[0] * 1e9 + time[1]) / 1e6) / 1000) + ' seconds.');
  start = process.hrtime();
  if (tty) {
    process.stdout.clearLine();
    process.stdout.write('Sending back results... Packages processed: ' + packages);
    process.stdout.cursorTo(0);
  }
  ajax('result', {packageId: pkgId, result: results});
  results = [];
}

function connect(cb, path, method, headers, data, noAuth) {
  path = path || '/';
  method = method || 'GET';
  noAuth = noAuth || false;
  var req = https.request({
    host: host,
    port: port,
    path: path,
    method: method,
    rejectUnauthorized: (!noAuth),
    ca: (ca === true)?undefined:ca,
    requestCert: true,
    agent: false,
    headers: headers
  }, cb);
  req.on('error', function(err) {
    if (err.code == 'SELF_SIGNED_CERT_IN_CHAIN') {
      if (ca != undefined) return;
      console.log('Server\'s self signed certificate not in cert store. To add host ca to cert store run with `-ca`');
      process.exit();
    }
    console.error(err);
    console.log('Trying again in 10 seconds.');
    if (getPackageTimer) clearTimeout(getPackageTimer);
    getPackageTimer = setTimeout(getPackage, 10000);
  });
  req.write(data);
  req.end();
}

if (ca !== true) getPackage();
//}

//{ Work pump
function doDLL(dllPath) {
  completed = 0;
  start = process.hrtime();
  //proc = new Function('a', 'b', 'i', 'c', 'var proc = ' + proc + ';\nreturn proc(a, b, i, c);');
  eval('proc = ' + proc + ';');
  for (var i = 0; i < inputData.length; i++) {
    proc(inputData[i][1], dllPath, i, function(out, i) {
      gotResult({data: {i: i, out: out}});
    });
  }
}

function doWork() {
  startWorkers();
  completed = 0;
  start = process.hrtime();
  if (staticScheduling)
    c = Math.ceil(inputData.length / workers.length); // Partition data for workers (static scheduling)
  for (var i = 0, n = workers.length; i < n; i++) {
    if (inputData.length > i*c) {
      if (!staticScheduling)
        inputData[i].taken = true;
      workers[i].postMessage({data: inputData.slice(i*c, i*c+c)});
    }
  }
}

// Process results
var results = [];
var t = Date.now();
var bufferCheckTimer;

function gotResult(e) {
  results.push([e.data.i, e.data.out]);
  var i = getIndex(inputData, e.data.i);
  if (i >= 0) inputData.splice(i, 1); // Remove completed
  completed++;
  if (!staticScheduling) { // Send next bit of data
    for (var i2 = 0; i2 < inputData.length; i2++) {
      if (!inputData[i2].taken) {
        inputData[i2].taken = true;
        this.postMessage({data: [inputData[i2]]});
        break;
      }
    }
  }
  if (bufferCheckTimer) clearTimeout(bufferCheckTimer);
  bufferCheck();
}

function getIndex(a, s) {
  for (var i = 0, n = a.length; i < n; i++)
    if (a[i][0] == s) return i;
  return -1; // Element not found
}

// Buffer manager
function bufferCheck() {
  if ((results.length > 0 && (Date.now()-t >= 60000 || inputData.length < 1)) || results.length > 5000) {
    sendResults(); // Send back (partial) results to server
    if (inputData.length < 1) { // All done, so stop timer, and send request for more tasks
      getPackage();
      return;
    }
    t = Date.now();
  }
  bufferCheckTimer = setTimeout(bufferCheck, 60000);
}
//}

//{ Worker code
function func() {
  var id = Math.floor(Math.random() * 9999); // Random worker id if not specified
  if (typeof asmjs == 'function') asmjs();
  onmessage = function(e) {
    if (typeof e.data.id == 'number') // Assign worker id
      id = e.data.id;
    if (typeof e.data.data == 'object')
      for (var i = 0, n = e.data.data.length; i < n; i++)
        postMessage({id: id, i: e.data.data[i][0], out: proc(e.data.data[i][1])}); // Pump input array trough processor function, and return results one by one
  };
}
//}
