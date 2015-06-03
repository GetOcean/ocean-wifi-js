var fs = require('fs');

// Read and eval library
var Promise = require("es6-promise").Promise;
filedata = fs.readFileSync('./wifi/wifi.js','utf8');
eval(filedata);

exports.wifi = wifi;