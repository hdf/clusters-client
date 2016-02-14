># **Clusters Client**
>### _Node.js client for [Clusters](https://github.com/hdf/clusters) work distribution system using [webworker-threads](https://github.com/audreyt/node-webworker-threads) and/or [node-ffi](https://github.com/node-ffi/node-ffi)_

<br>
## Installation
Install [Node.js](https://nodejs.org/en/)

_Optionally_ install forever:
>`npm i -g forever`

Install clusters-client:
>`npm i -g https://github.com/hdf/clusters-client.git`

<br>
## Usage
>`clusters-client localhost:8082`

This will work as well (if say, the server is behind an nginx reverse proxy):
>`clusters-client https://localhost/clusters/`

If you have [MinGW-w64](http://sourceforge.net/projects/mingw-w64/) and [MSYS2](http://msys2.github.io/) installed on Windows, or are on Linux, than you can lower process priority for the workers like this:
>`nice -n 10 clusters-client localhost:8082`

<br>
### LICENSE
>[MIT](https://opensource.org/licenses/MIT)
