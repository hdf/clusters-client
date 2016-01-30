"use strict";

var os = require('os'),
    https = require('https'),
    url = require('url'),
    zlib = require('zlib'),
    tty = require('tty').isatty(),
    Worker = require('webworker-threads').Worker;

var host = 'localhost', port = 8082, prefix = '',
    cores = os.cpus().length || 1,
    workers = [], proc = '', inputData = [], packages = 0,
    completed = 0, max = 0, // For progress meter
    c = 1, // Partition data for workers (dynamic scheduling)
    staticScheduling = false; // This is a switch (for the c above)!

//{ Command Line parameter parsing
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
console.log('Connecting to package manager server at: \'' + host + '\' on port: ' + port + ' at path: \'' + prefix + '/\' using ' + cores + ' cores.');
//}

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
    if (workers.length < 1) {
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
  ajax('get', {packageId: pkgId}, function(res) {
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
    getPackageTimer = setTimeout(getPackage, 60000);
    return;
  }
  if (tty) {
    process.stdout.write('Got new package (' + packages + '). Processing...');
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
  doWork();
}

function sendResults() {
  packages++;
  if (tty) {
    process.stdout.clearLine();
    process.stdout.write('Sending back results... Packages processed: ' + packages);
    process.stdout.cursorTo(0);
  }
  ajax('result', {packageId: pkgId, result: results});
  results = [];
}

function connect(cb, path, method, headers, data) {
  path = path || '/';
  method = method || 'GET';
  var req = https.request({
    host: host,
    port: port,
    path: path,
    method: method,
    rejectUnauthorized: false,
    requestCert: true,
    agent: false,
    headers: headers
  }, cb);
  req.on('error', function(err) {
    console.error(err);
  });
  req.write(data);
  req.end();
}

getPackage();
//}

//{ Work pump
function doWork() {
  startWorkers();
  completed = 0;
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
