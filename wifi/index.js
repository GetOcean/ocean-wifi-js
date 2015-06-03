var fs = require('fs');
var util = require('util');
var exec = require('child_process').exec;
var _ = require('underscore');
var Promise = require("es6-promise").Promise;

String.prototype.format = function (arguments) {
    var this_string = '';
    for (var char_pos = 0; char_pos < this.length; char_pos++) {
        this_string = this_string + this[char_pos];
    }

    for (var key in arguments) {
        var string_key = '{' + key + '}'
        this_string = this_string.replace(new RegExp(string_key, 'g'), arguments[key]);
    }
    return this_string;
};

filedata = fs.readFileSync('./wifi/wifi.js','utf8');
eval(filedata);

exports.wifi = wifi;