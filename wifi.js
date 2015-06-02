///
///  @file wifi.js
///
///  Created by David Petrie.
///  Copyright (c) 2015 iCracked Inc. All rights reserved.
///
///  @brief Library for manipulating WiFi on BlueOcean devices. Adapted from node-wireless library.
///

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var exec = require('child_process').exec;
var _ = require('underscore');

///
/// TODO: Locks around executeScan!
///
var wifi = (function() {

    var wifi = {},
        // Scanner timer reference
        scanTimer = null,

        // Connection timer reference
        connectTimer = null,
        
        // True if connected to a network
        connected = true,

        // @iface: Interface to listen on.
        // @updateFrequency: how often to poll the network list.
        // @connectionTestFrequency: how often to check if we are connected.
        // @vanishThreshold: scans to determine if an AP is not available.
        config = {
            iface : "wlan0",
            updateFrequency : 10,
            connectionTestFrequency : 2,
            vanishThreshold : 2
        },

        CONSOLE_COMMANDS = {
            scan: 'sudo iwlist :INTERFACE scan',
            stat: 'sudo iwconfig :INTERFACE',
            disable: 'sudo ifconfig :INTERFACE down',
            enable: 'sudo ifconfig :INTERFACE up',
            interfaces: 'sudo iwconfig',
            dhcp: 'sudo dhcpcd :INTERFACE',
            dhcp_disable: 'sudo dhcpcd :INTERFACE -k',
            leave: 'sudo iwconfig :INTERFACE essid ""',

            metric: 'sudo ifconfig :INTERFACE metric :METRIC',
            connect_wep: 'sudo iwconfig :INTERFACE essid ":ESSID" key :PASSWORD',
            connect_wpa: 'sudo wpa_passphrase ":ESSID" :PASSWORD > wpa-temp.conf && sudo wpa_supplicant -D wext -i :INTERFACE -c wpa-temp.conf && rm wpa-temp.conf',
            connect_open: 'sudo iwconfig :INTERFACE essid ":ESSID"',
        },

        commands = {},

        // List of networks (key is address)
        networks = {};



    function start(config) {
        return new Promise(function(resolve, reject) {
            wifi.commands = _.extend({}, wifi.CONSOLE_COMMANDS, config.commands);

            // Translates each individual command
            for (var command in wifi.commands) {
                wifi.commands[command] = wifi._translate(wifi.commands[command], {
                    'interface': wifi.config.iface,
                });
            }

            // Start network scanner
            wifi._executeScan();
            this.scanTimer = setInterval(function() {
                wifi._executeScan();
            }, wifi.config.updateFrequency * 1000);

            // Start connection loop.
            wifi._executeTrackConnection();
            wifi.connectTimer = setInterval(function() {
                wifi._executeTrackConnection();
            }, wifi.config.connectionTestFrequency * 1000);

            resolve();
        });
    }


    ///
    /// Log to console, or show an alert dialog box if the console is unavailable.
    ///
    /// @param message the message to be logged to the console.
    ///
    function defaultLog(message) {
        if (typeof console.log != 'function') {
            alert('No console.');
        } else {
            console.log(message);
        }
    }


    /// 
    /// Stop listening
    ///
    function stop(callback) {
        this.killing = true;
        clearInterval(this.scanTimer);
        clearInterval(this.connectTimer);

        this.emit('stop');

        callback && callback();
    };


    /// 
    /// List of networks as of the last scan.
    ///
    function list = function() {
        return this.networks;
    };


    ///
    /// Attempts to run dhcpcd on the interface to get us an IP address
    ///
    function dhcp (callback) {
        var self = this;

        return new Promise(function(resolve, reject) {
            wifi.onCommand(this.commands.dhcp);

            exec(this.commands.dhcp, function(err, stdout, stderr) {
                if (err) {
                    wifi.error("There was an unknown error enabling dhcp" + err);
                    callback && callback(err);
                    return;
                }

                // Command output is over stderr :'(
                var lines = stderr.split(/\r\n|\r|\n/);
                var ip_address = null;
                var temp = null;

                _.each(lines, function(line) {
                    temp = line.match(/leased (\b(?:\d{1,3}\.){3}\d{1,3}\b) for [0-9]+ seconds/);
                    if (temp) {
                        ip_address = temp[1];
                    }
                });

                if (ip_address) {
                    self.emit('dhcp', ip_address);
                    callback && callback(null, ip_address);
                    return;
                } else {
                    wifi.error("Couldn't get an IP Address from DHCP");
                    callback && callback(true);
                }
            });
        });
    };


    ///
    /// Disables DHCPCD
    ///
    function dhcpStop() {
        var self = this;

        return new Promise(function(resolve, reject) {
            wifi.onCommand(this.commands.dhcp_disable);

            exec(this.commands.dhcp_disable, function(err, stdout, stderr) {
                if (err) {
                    wifi.error("There was an unknown error disabling dhcp" + err);
                    reject();
                } else {
                    resolve();
                }
            });
        });
    };


    ///
    /// Enables the interface (ifconfig UP)
    ///
    function enable(callback) {
        var self = this;

        return new Promise(function(resolve, reject) {
            wifi.onCommand(this.commands.enable);

            exec(this.commands.enable, function(err, stdout, stderr) {
                if (err) {
                    if (err.message.indexOf("No such device")) {
                        wifi.error("The interface " + self.iface + " does not exist.");
                        reject(err);
                    } else {
                        wifi.error("There was an unknown error enabling the interface" + err);
                        reject(err);
                    }
                } else if (stdout || stderr) {
                    wifi.error("There was an error enabling the interface" + stdout + stderr);
                    reject(stdout || stderr);
                } else {
                    resolve();
                }
            });
        });
    };


    ///
    /// Disables the interface (ifconfig DOWN)
    ///
    function disable() {
        var self = this;
        return new Promise(function(resolve, reject) {
            wifi.onCommand(this.commands.disable);

            exec(this.commands.disable, function(err, stdout, stderr) {
                if (err) {
                    wifi.error("There was an unknown error disabling the interface" + err);
                    reject(err);
                } else if (stdout || stderr) {
                    wifi.error("There was an error disabling the interface" + stdout + stderr);
                    reject(stdout || stderr);
                } else {
                    resolve();
                }
            });
        });
    }


    ///
    /// Attempts to connect to the specified network
    ///
    function join(network, password, callback) {
        if (network.encryption_wep) {
            this._executeConnectWEP(network.ssid, password, callback);
        } else if (network.encryption_wpa || network.encryption_wpa2) {
            this._executeConnectWPA(network.ssid, password, callback);
        } else {
            this._executeConnectOPEN(network.ssid, callback);
        }
    };


    /// 
    /// Connect to a WEP encrypted network
    ///
    function _executeConnectWEP(essid, password, callback) {
        var self = this;

        var command = this._translate(this.commands.connect_wep, {
            essid: essid,
            password: password
        });

        wifi.onCommand(command);

        exec(command, function(err, stdout, stderr) {
            if (err || stderr) {
                wifi.error("Shit is broken TODO");
                console.log(err);
                console.log(stderr);

                callback && callback(err || stderr);
                return;
            }

            callback && callback(null);
        });
    };


    ///
    /// Connect to a WPA or WPA2 encrypted network
    ///
    function _executeConnectWPA(essid, password, callback) {
        var self = this;

        var command = this._translate(this.commands.connect_wpa, {
            essid: essid,
            password: password
        });

        wifi.onCommand(command);

        exec(command, function(err, stdout, stderr) {
             if (err || stderr) {
                wifi.error("Shit is broken TODO");
                console.log(err);
                console.log(stderr);

                callback && callback(err || stderr);
                return;
            }

            callback && callback(null);
        });
    };


    ///
    /// Connect to an open network
    ///
    function _executeConnectOPEN(essid, callback) {
        var self = this;

        var command = this._translate(this.commands.connect_open, {
            essid: essid
        });

        wifi.onCommand(command);

        exec(command, function(err, stdout, stderr) {
            if (err || stderr) {
                wifi.error("There was an error joining an open network");
                console.log(err);
                console.log(stderr);

                callback && callback(err || stdout);
                return;
            }

            callback && callback(null);
        });
    };


    /// 
    /// Attempts to disconnect from the specified network
    ///
    function leave(callback) {
        var self = this;

        wifi.onCommand(this.commands.leave);
        exec(this.commands.leave, function(err, stdout, stderr) {
            if (err) {
                wifi.error("There was an error when we tried to disconnect from the network");
                callback && callback(err);
                return;
            }

            callback && callback(null);
        });
    };


    // Translates strings. Looks for :SOMETHING in string, and replaces is with data.something.
    function _translate(string, data) {
        for (var index in data) {
            if (!data.hasOwnProperty(index)) break;
            string = string.replace(':' + index.toUpperCase(), data[index]);
        }

        return string;
    };


    /// 
    /// Parses the output from `iwlist IFACE scan` and returns a pretty formattted object
    ///
    function _parseScan(scanResults) {
        var lines = scanResults.split(/\r\n|\r|\n/);
        var networks = [];
        var network = {};
        var networkCount = 0;

        _.each(lines, function(line) {
            line = line.replace(/^\s+|\s+$/g,"");

            // a "Cell" line means that we've found a start of a new network
            if (line.indexOf('Cell') === 0) {
                networkCount++;
                if (!_.isEmpty(network)) {
                    networks.push(network);
                }

                network = {
                    //speeds: []
                    last_tick: 0,
                    encryption_any: false,
                    encryption_wep: false,
                    encryption_wpa: false,
                    encryption_wpa2: false,
                };

                network.address = line.match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/)[0];
            } else if (line.indexOf('Channel') === 0) {
                network.channel = line.match(/Channel:([0-9]{1,2})/)[1];
            } else if (line.indexOf('Quality') === 0) {
                network.quality = line.match(/Quality=([0-9]{1,2})\/70/)[1];
                network.strength = line.match(/Signal level=(-?[0-9]{1,3}) dBm/)[1];
            } else if (line.indexOf('Encryption key') === 0) {
                var enc = line.match(/Encryption key:(on|off)/)[1];
                if (enc === 'on') {
                    network.encryption_any = true;
                    network.encryption_wep = true;
                }
            } else if (line.indexOf('ESSID') === 0) {
                network.ssid = line.match(/ESSID:"(.*)"/)[1];
            } else if (line.indexOf('Mode') === 0) {
                network.mode = line.match(/Mode:(.*)/)[1];
            } else if (line.indexOf('IE: IEEE 802.11i/WPA2 Version 1') === 0) {
                network.encryption_wep = false;
                network.encryption_wpa2 = true;
            } else if (line.indexOf('IE: WPA Version 1') === 0) {
                network.encryption_wep = false;
                network.encryption_wpa = true;
            }
        });

        if (!_.isEmpty(network)) {
            networks.push(network);
        }

        // TODO: Deprecated, will be removed in 0.5.0 release
        if (networkCount === 0) {
            this.onEmpty();
        }

        return networks;
    };


    // Executes a scan, reporting each network we see
    function _executeScan() {
        var self = this;

        // Make this a non annonymous function, run immediately, then run interval which runs function
        wifi.onCommand(this.commands.scan);

        exec(this.commands.scan, function(err, stdout, stderr) {
            if (err) {
                if (self.killing) {
                    // Of course we got an error the main app is being killed, taking iwlist down with it
                    return;
                }

                wifi.error("Got some major errors from our scan command:" + err);
            } else if (stderr) {
                if (stderr.match(/Device or resource busy/)) {
                    wifi.error("Scans are overlapping; slow down update frequency");
                } else if (stderr.match(/Allocation failed/)) {
                    wifi.error("Too many networks for iwlist to handle");
                } else {
                    wifi.error("Got some errors from our scan command: ", stderr);
                }
            } else if (stdout) {
                var content = stdout.toString();
                var networks = self._parseScan(content);

                _.each(networks, function(network) {
                    self._seeNetwork(network);
                });

                self._decay();
            }
        });
    };


    /// 
    /// Every time we find a network during a scan, we pass it through this function
    ///
    function _seeNetwork(network) {
        if (this.networks[network.address]) {
            var oldNetwork = this.networks[network.address];

            if (oldNetwork.ssid != network.ssid || oldNetwork.encryption_any != network.encryption_any) {
                wifi.onChange(network);
            } else if (oldNetwork.strength != network.strength || oldNetwork.quality != network.quality) {
                wifi.onSignal(network);
            }

            this.networks[network.address] = network;
        } else {
            this.networks[network.address] = network;

            wifi.onAppear(network);
        }
    };


    // Checks to see if we are connected to a wireless network and have an IP address
    function _executeTrackConnection() {
        var self = this;

        wifi.onCommand(this.commands.stat);

        exec(this.commands.stat, function(err, stdout, stderr) {
            if (err) {
                wifi.error("Error getting wireless devices information");
                // TODO: Destroy
                return;
            }

            var content = stdout.toString();
            var lines = content.split(/\r\n|\r|\n/);
            var foundOutWereConnected = false;
            var networkAddress = null;

            _.each(lines, function(line) {
                if (line.indexOf('Access Point') !== -1) {
                    networkAddress = line.match(/Access Point: ([a-fA-F0-9:]*)/)[1] || null;

                    if (networkAddress) {
                        foundOutWereConnected = true;
                    }
                }
            });

            // guess we're not connected after all
            if (!foundOutWereConnected && wifi.connected) {
                wifi.connected = false;
                wifi.onLeave();
            } else if (foundOutWereConnected && !wifi.connected) {
                wifi.connected = true;
                var network = wifi.networks[networkAddress];

                if (network) {
                    wifi.onJoin(network);
                } else {
                    wifi.onFormer(networkAddress);
                }
            }
        });
    };


    /// 
    /// For each network, increment last_tick, if it equals the threshold, send an event
    ///
    function _decay() {
        for (var address in this.networks) {
            if (!this.networks.hasOwnProperty(address)) {
                break;
            }

            var this_network = this.networks[address];
            this_network.last_tick++;

            if (this_network.last_tick == this.vanishThreshold+1) {
                wifi.onVanish(this_network);
            }
        }
    };


    ///
    /// Public functions
    ///
    wifi.log = defaultLog;
    wifi.error = defaultLog;

    ///
    /// Fixed functions.  Callable but should not be replaced.
    ///
    wifi.start = start;

    ///
    /// Listener functions
    ///
    wifi.onAppear = function(event) { wifi.log(event); };
    wifi.onChange = function(event) { wifi.log(event); };
    wifi.onSignal = function(event) { wifi.log(event); };
    wifi.onEmpty = function(event) { wifi.log(event); };
    wifi.onCommand = function(event) { wifi.log(event); };
    wifi.onJoin = function(event) { wifi.log(event); };
    wifi.onFormer = function(event) { wifi.log(event); };
    wifi.onDHCP = function(event) { wifi.log(event); };
    wifi.onStop = function(event) { wifi.log(event); };
    wifi.onVanish = function(event) { wifi.log(event); };
    
    return wifi;
} ());
