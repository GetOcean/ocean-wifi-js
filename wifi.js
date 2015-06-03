///
///  @file wifi.js
///
///  Created by David Petrie.
///  Copyright (c) 2015 iCracked Inc. All rights reserved.
///
///  @brief Library for manipulating WiFi on BlueOcean devices. Adapted from node-wireless library.
///

var util = require('util');
var exec = require('child_process').exec;
var _ = require('underscore');


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
            scan: 'sudo iwlist {interface} scan',
            stat: 'sudo iwconfig {interface}',
            disable: 'sudo ifconfig {interface} down',
            enable: 'sudo ifconfig {interface} up',
            interfaces: 'sudo iwconfig',
            dhcp: 'sudo dhcpcd {interface}',
            dhcp_disable: 'sudo dhcpcd {interface} -k',
            leave: 'sudo iwconfig {interface} essid ""',

            metric: 'sudo ifconfig {interface} metric {metric}',
            connect_wep: 'sudo iwconfig {interface} essid "{essid}" key {password}',
            connect_wpa: 'sudo wpa_passphrase "{essid}" {password} > wpa-temp.conf && sudo wpa_supplicant -D wext -i {interface} -c wpa-temp.conf && rm wpa-temp.conf',
            connect_open: 'sudo iwconfig {interface} essid "{essid}"',
        },

        commands = {},

        // List of networks (key is address)
        networks = {};


    function start(config) {
        return new Promise(function(resolve, reject) {
            /*
            wifi.commands = _.extend({}, wifi.CONSOLE_COMMANDS, config.commands);

            // Translates each individual command
            for (var command in wifi.commands) {
                wifi.commands[command] = wifi._translate(wifi.commands[command], {
                    'interface': wifi.config.iface,
                });
            }*/

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
    /// Stop listening
    ///
    function stop() {
        return new Promise(function(resolve, reject) {
            this.killing = true;
            clearInterval(this.scanTimer);
            clearInterval(this.connectTimer);
            wifi.onStop();
            resolve();
        }
    };


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
    /// List of networks as of the last scan.
    ///
    function list = function() {
        return this.networks;
    };


    function execDHCP(callback) {
        var command = wifi.commands.dhcp;
        var args = {
            'interface': wifi.config.interface
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execDHCPDisable(callback) {
        var command = wifi.commands.dhcp_disable;
        var args = {
            'interface': wifi.config.interface
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execEnable(callback) {
        var command = wifi.commands.enable;
        var args = {
            'interface': wifi.config.interface
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execDisable(callback) {
        var command = wifi.commands.disable;
        var args = {
            'interface': wifi.config.interface
        };
        command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    /// 
    /// Connect to a WEP encrypted network
    ///
    function execConnectWEP(network, password, callback) {
        var command = wifi.commands.connect_wep;
        var args = {
            'interface': wifi.config.interface,
            'essid': network.essid,
            'password': password
        };
        command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    ///
    /// Connect to a WPA2 or WPA enabled network, while preserving the network id and password.
    ///
    function execConnectWPA(network, password, callback) {
        var command = wifi.commands.connect_wpa;
        var args = {
            'interface': wifi.config.interface,
            'essid': network.essid,
            'password': password
        };
        command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    ///
    /// Connect to the given network password.
    ///
    function execConnectOpen(network, callback) {
        var command = wifi.commands.connect_open;
        var args = {
            'interface': wifi.config.interface,
            'essid': network.essid
        };
        command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execLeave(network, callback) {
        var command = wifi.commands.leave;
        var args = {
            'interface': wifi.config.interface
        };
        command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execScan(callback) {
        var command = wifi.commands.scan;
        var args = {
            'interface': wifi.config.interface
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);       
    }


    function execTrackConnection(callback) {
        var command = wifi.commands.stat;
        var args = {
            'interface': wifi.config.interface
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);       
    }


    ///
    /// Attempts to run dhcpcd on the interface to get us an IP address
    ///
    function dhcp () {
        return new Promise(function(resolve, reject) {
            wifi.execDHCP(function(err, stdout, stderr) {
                if (err) {
                    wifi.error("There was an unknown error enabling dhcp" + err);
                    reject(err);
                } else {
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
                        self.onDHCP(ip_address);
                        resolve(ip_address);
                    } else {
                        wifi.error("Couldn't get an IP Address from DHCP");
                        reject();
                    }
                }
            });
        });
    };


    ///
    /// Disables DHCPCD
    ///
    function dhcpStop() {
        return new Promise(function(resolve, reject) {
            wifi.execDHCPDisable(function(err, stdout, stderr) {
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
    function enable() {
        return new Promise(function(resolve, reject) {
            wifi.execEnable(function(err, stdout, stderr) {
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
        return new Promise(function(resolve, reject) {
            wifi.execDisable(function(err, stdout, stderr) {
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
    function join(network, password) {
        if (network.encryption_wep) {
            return new Promise(function(resolve, reject) {
                wifi.execConnectWEP(network, password, function(err, stdout, stderr) {
                    if (err || stderr) {
                        wifi.error(err);
                        wifi.error(stderr);
                        reject(err || stderr);
                    } else {
                        resolve();
                    }
                });
            });
        } else if (network.encryption_wpa || network.encryption_wpa2) {
            return new Promise(function(resolve, reject) {
                wifi.execConnectWPA(network, password, function(err, stdout, stderr) {
                    if (err || stderr) {
                        wifi.error(err);
                        wifi.error(stderr);
                        reject(err || stderr);
                    } else {
                        resolve();
                    }
                });
            });
        } else {
            return new Promise(function(resolve, reject) {
                wifi.execConnectOpen(network, function(err, stdout, stderr) {
                    if (err || stderr) {
                        wifi.error(err);
                        wifi.error(stderr);
                        reject(err || stderr);
                    } else {
                        resolve();
                    }
                });
            });
        }
    }


    /// 
    /// Attempts to disconnect from the specified network
    ///
    function leave(network) {
        return new Promise(function(resolve, reject) {
            wifi.execLeave(network, function(err, stdout, stderr) {
                if (err) {
                    wifi.error("There was an error when we tried to disconnect from the network");
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }


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


    /// 
    /// Scan the current network list, and then check the list to see if anything has changed.
    ///
    function _executeScan() {
        wifi.execScan(function(err, stdout, stderr) {
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
                    if (wifi.networks[network.address]) {
                        var oldNetwork = wifi.networks[network.address];

                        if (oldNetwork.ssid != network.ssid || oldNetwork.encryption_any != network.encryption_any) {
                            wifi.onChange(network);
                        } else if (oldNetwork.strength != network.strength || oldNetwork.quality != network.quality) {
                            wifi.onSignal(network);
                        }

                        wifi.networks[network.address] = network;
                    } else {
                        wifi.networks[network.address] = network;
                        wifi.onAppear(network);
                    }
                });

                // For each network, increment last_tick, if it equals the threshold, send an event
                for (var address in this.networks) {
                    if (!wifi.networks.hasOwnProperty(address)) {
                        break;
                    }

                    var this_network = wifi.networks[address];
                    this_network.last_tick++;

                    if (this_network.last_tick == wifi.config.vanishThreshold+1) {
                        wifi.onVanish(this_network);
                    }
                }
            }
        });
    };


    ///
    /// Checks to see if we are connected to a wireless network and have an IP address.
    ///
    function _executeTrackConnection() {
        wifi.execTrackConnection(function(err, stdout, stderr) {
            if (err) {
                wifi.error("Error getting wireless devices information");
            } else {
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
            }
        });
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
