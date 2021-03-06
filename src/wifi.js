///
///  @file wifi.js
///
///  Created by David Petrie.
///  Copyright (c) 2015 iCracked Inc. All rights reserved.
///
///  @brief Library for manipulating WiFi on BlueOcean devices. Adapted from node-wireless library.
///

///
/// TODO: Locks around executeScan!
///
var wifi = (function() {

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


    var wifi = {},
        killing = true,

        // Scanner timer reference
        scanTimer = null,

        // Connection timer reference
        connectTimer = null,

        // True if connected to a network
        connected = true,

        // Current network
        connectedNetwork = null,

        // @interfaces: A list of interface to listen on.
        // @interfaceIndex: starting interface index
        // @updateFrequency: how often to poll the network list.
        // @connectionTestFrequency: how often to check if we are connected.
        // @vanishThreshold: scans to determine if an AP is not available.
        defaultOptions = {
            interfaces : ["wlan0"],
            interfaceIndex : 0,
            updateFrequency : 10,
            connectionTestFrequency : 10,
            vanishThreshold : 10
        },

        options = {},

        commands = {},

        // List of networks (key is address)
        networks = {};


    function start(opts) {
        var promise = new Promise(function(resolve, reject) {
            options = _.extend({}, opts, defaultOptions);

            _executeScan();
            _executeTrackConnection();

            scanTimer = setInterval(function() {
                _executeScan();
            }, options.updateFrequency * 1000);

            connectTimer = setInterval(function() {
                _executeTrackConnection();
            }, options.connectionTestFrequency * 1000);

            resolve();
        });

        return promise;
    }


    ///
    /// Stop listening
    ///
    function stop() {
        return new Promise(function(resolve, reject) {
            killing = true;
            clearInterval(scanTimer);
            clearInterval(connectTimer);
            wifi.onStop();
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
            //console.log(message);
        }
    }


    ///
    /// List of networks as of the last scan.
    ///
    function list() {
        return networks;
    }


    ///
    /// Currently connected network
    ///
    function currentNetwork() {
        return connectedNetwork;
    }


    ///
    /// Attempts to run dhcpcd on the interface to get us an IP address
    ///
    function dhcp () {
        return new Promise(function(resolve, reject) {
            execDHCP(function(err, stdout, stderr) {
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
                        wifi.onDHCP(ip_address);
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
            execDHCPDisable(function(err, stdout, stderr) {
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
    /// Gets the IP address for the current interface.
    ///
    function getIP() {
        return new Promise(function(resolve, reject) {
            execGetIP(function(err, stdout, stderr) {
                if (err) {
                    wifi.error("There was an error retr dhcp" + err);
                    reject();
                } else {
                    var ipAddress = stdout.toString();
                    if (ipAddress.length > 0) {
                        var ips = ipAddress.split(" ");
                        resolve(ips);
                    } else {
                        resolve();
                    }
                }
            });
        });
    };


    ///
    /// Enables the interface (ifconfig UP)
    ///
    function enable() {
        return new Promise(function(resolve, reject) {
            execEnable(function(err, stdout, stderr) {
                if (err) {
                    if (err.message.indexOf("No such device")) {
                        wifi.error("The interface does not exist.");
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
            execDisable(function(err, stdout, stderr) {
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
    function join(address, password) {
        return new Promise(function(resolve, reject) {
            var network = networks[address];
            if (network) {
                if (network.encryption_wpa || network.encryption_wpa2) {
                    execConnectWPA(network, password, function(err, stdout, stderr) {
                        if (err || stderr) {
                            wifi.error(err);
                            wifi.error(stderr);
                            reject(err || stderr);
                        } else {
                            resolve();
                        }
                    });
                } else if (network.encryption_wep) {
                    execConnectWEP(network, password, function(err, stdout, stderr) {
                        if (err || stderr) {
                            wifi.error(err);
                            wifi.error(stderr);
                            reject(err || stderr);
                        } else {
                            resolve();
                        }
                    });
                } else {
                    execConnectOpen(network, function(err, stdout, stderr) {
                        if (err || stderr) {
                            wifi.error(err);
                            wifi.error(stderr);
                            reject(err || stderr);
                        } else {
                            resolve();
                        }
                    });
                }
            } else {
                reject("Could not find the network with address " + address);
            }
        });
    }


    ///
    /// Attempts to disconnect from the specified network
    ///
    function leave(address) {
        return new Promise(function(resolve, reject) {
            var network = networks[address];
            if (network) {
                execLeave(network, function(err, stdout, stderr) {
                    if (err) {
                        wifi.error("There was an error when we tried to disconnect from the network");
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            } else {
                reject("Could not find the network with address " + address);
            }
        });
    }


    function printDebugNetworkInfo(network) {
        var encryption_type = 'NONE';
        if (network.encryption_wep) {
            encryption_type = 'WEP';
        } else if (network.encryption_wpa && network.encryption_wpa2) {
            encryption_type = 'WPA&WPA2';
        } else if (network.encryption_wpa) {
            encryption_type = 'WPA';
        } else if (network.encryption_wpa2) {
            encryption_type = 'WPA2';
        }

        wifi.log("{essid} [{address}] {quality}% {strength} dBm {encryption_type}", {
            'essid': network.essid || '<HIDDEN>',
            'address': network.address,
            'quality': Math.floor(network.quality / 70 * 100),
            'strength': network.strength,
            'encryption_type': encryption_type
        });
    }


    function execDHCP(callback) {
        var command = 'sudo dhcpcd {interface}';
        var args = {
            'interface': options.interfaces[options.interfaceIndex]
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execDHCPDisable(callback) {
        var command = 'sudo dhcpcd {interface} -k';
        var args = {
            'interface': options.interfaces[options.interfaceIndex]
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execGetIP(callback) {
        var USE_IFCONFIG_UP = false;
        var command = 'hostname -I';
        if (USE_IFCONFIG_UP == true) {
            command = 'ifconfig wlan0 | grep inet | awk \'\{print \$2\}\' | sed \'s\/addr:\/\/\'';
            var args = {
                'interface' : options.interfaces[options.interfaceIndex]
            };
            command = command.format(args);
        }

        wifi.onCommand(command);
        exec(command, callback);
    }


    function execEnable(callback) {
        var command = 'sudo ifconfig {interface} up';
        var args = {
            'interface': options.interfaces[options.interfaceIndex]
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execDisable(callback) {
        var command = 'sudo ifconfig {interface} down';
        var args = {
            'interface': options.interfaces[options.interfaceIndex]
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    ///
    /// Connect to a WPA2 or WPA enabled network, while preserving the network id and password.
    ///
    function execConnectWPA(network, password, callback) {
        var wpa_command = 'sudo wpa_passphrase "{essid}" "{password}" >> /etc/wpa_supplicant/wpa_supplicant.conf'
        var reset_command = 'sudo ifdown --force {interface} && sudo ifup {interface}';
        var args = {
            'interface': options.interfaces[options.interfaceIndex],
            'essid': network.essid,
            'password': password
        };
        wpa_command = wpa_command.format(args);
        reset_command = reset_command.format(args);

        wifi.onCommand(reset_command);
        exec(wpa_command, function(err, stdout, stderr) {
            exec(reset_command, callback);
        });
    }


    ///
    /// Connect to a WEP encrypted network
    ///
    function execConnectWEP(network, password, callback) {
        var command = 'sudo iwconfig {interface} essid "{essid}" key {password}';
        var args = {
            'interface': options.interfaces[options.interfaceIndex],
            'essid': network.essid,
            'password': password
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    ///
    /// Connect to the given network password.
    ///
    function execConnectOpen(network, callback) {
        var command = 'sudo iwconfig {interface} essid "{essid}"';
        var args = {
            'interface': options.interfaces[options.interfaceIndex],
            'essid': network.essid
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execLeave(network, callback) {
        var command = 'sudo iwconfig {interface} essid ""';
        var args = {
            'interface': options.interfaces[options.interfaceIndex]
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execScan(callback) {
        var command = 'sudo iwlist {interface} scan';
        var args = {
            'interface': options.interfaces[options.interfaceIndex]
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    function execTrackConnection(callback) {
        var command = 'sudo iwconfig {interface}';
        var args = {
            'interface': options.interfaces[options.interfaceIndex]
        };
        command = command.format(args);
        wifi.onCommand(command);
        exec(command, callback);
    }


    ///
    /// Parses the output from `iwlist {interface scan` and returns a pretty formattted object.
    ///
    /// This parsing really sucks.
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
                    if (network.essid.indexOf('\\x00\\x00\\x00\\x00') > -1) {
                        //console.log("Skipping network")
                    } else {
                        networks.push(network);
                    }
                    //networks.push(network);
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
                var channel = line.match(/Channel:([0-9]{1,2})/);

                if (channel && channel.length >= 2) {
                    network.channel = channel[1];
                }
            } else if (line.indexOf('Quality') === 0) {
                var quality = line.match(/Quality:([0-9]{1}\/[0-9]{1})/);
                var strength = line.match(/Signal level:(-?[0-9]{1,3}) dBm/);

                if (quality && quality.length >= 2) {
                    network.quality = quality[1];
                }

                if (strength && strength.length >= 2) {
                    network.strength = strength[1];
                }
            } else if (line.indexOf('Encryption key') === 0) {
                var enc = line.match(/Encryption key:(on|off)/);

                if (enc && enc.length >= 2) {
                    enc = enc[1];
                    if (enc === 'on') {
                        network.encryption_any = true;
                        network.encryption_wep = true;
                    }
                }
            } else if (line.indexOf('ESSID') === 0) {
                var essid = line.match(/ESSID:"(.*)"/);

                if (essid && essid.length >= 2) {
                    network.essid = essid[1];
                }
            } else if (line.indexOf('Mode') === 0) {
                var mode = line.match(/Mode:(.*)/);

                if (mode && mode.length >= 2) {
                    network.mode = mode[1];
                }
            } else if (line.indexOf('IE: IEEE 802.11i/WPA2 Version 1') === 0) {
                network.encryption_wep = false;
                network.encryption_wpa2 = true;
            } else if (line.indexOf('IE: WPA Version 1') === 0) {
                network.encryption_wep = false;
                network.encryption_wpa = true;
            }
        });

        if (!_.isEmpty(network)) {
            if (network.essid.indexOf('\\x00\\x00\\x00\\x00') > -1) {
                //console.log("Skipping network")
            } else {
                networks.push(network);
            }
        }

        // TODO: Deprecated, will be removed in 0.5.0 release
        if (networkCount === 0) {
            wifi.onEmpty();
        }

        return networks;
    };


    ///
    /// Scan the current network list, and then check the list to see if anything has changed.
    ///
    function _executeScan() {
        execScan(function(err, stdout, stderr) {
            if (err) {
                if (killing) {
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
                var newNetworks = _parseScan(content);

                _.each(newNetworks, function(network) {
                    if (networks[network.address]) {
                        var oldNetwork = networks[network.address];

                        if (oldNetwork.essid != network.essid || oldNetwork.encryption_any != network.encryption_any) {
                            wifi.onChange(network);
                        } else if (oldNetwork.strength != network.strength || oldNetwork.quality != network.quality) {
                            wifi.onSignal(network);
                        }

                        networks[network.address] = network;
                    } else {
                        networks[network.address] = network;
                        wifi.onAppear(network);
                    }
                });

                // For each network, increment last_tick, if it equals the threshold, send an event
                for (var address in networks) {
                    if (!networks.hasOwnProperty(address)) {
                        break;
                    }

                    var this_network = networks[address];
                    this_network.last_tick++;

                    if (this_network.last_tick == options.vanishThreshold+1) {
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
        execTrackConnection(function(err, stdout, stderr) {
            if (err) {
                wifi.error("Error getting wireless devices information");
            } else if (stderr) {
                wifi.error(stderr);
            } else if (stdout) {
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
                if (!foundOutWereConnected && connected) {
                    connected = false;
                    connectedNetwork = null;
                    wifi.onLeave();
                } else if (foundOutWereConnected && !connected) {
                    connected = true;
                    connectedNetwork = networkAddress;
                    var network = networks[networkAddress];

                    if (network) {
                        wifi.onJoin(network);
                    } else {
                        wifi.onFormer(networkAddress);
                    }
                } else if (foundOutWereConnected && connected) {
                    connectedNetwork = networkAddress;
                }
            }
        });
    };


    function DefaultListenerFunction(event) {
        wifi.log(event);
    }


    ///
    /// Public functions
    ///
    wifi.log = defaultLog;
    wifi.error = defaultLog;
    wifi.start = start;
    wifi.list = list;
    wifi.currentNetwork = currentNetwork;
    wifi.stop = stop;
    wifi.dhcp = dhcp;
    wifi.dhcpStop = dhcpStop;
    wifi.getIP = getIP;
    wifi.enable = enable;
    wifi.disable = disable;
    wifi.join = join;
    wifi.leave = leave;

    ///
    /// Listener functions
    ///
    wifi.onAppear = DefaultListenerFunction;
    wifi.onChange = DefaultListenerFunction;
    wifi.onSignal = DefaultListenerFunction;
    wifi.onEmpty = DefaultListenerFunction;
    wifi.onCommand = DefaultListenerFunction;
    wifi.onJoin = DefaultListenerFunction;
    wifi.onLeave = DefaultListenerFunction;
    wifi.onFormer = DefaultListenerFunction;
    wifi.onDHCP = DefaultListenerFunction;
    wifi.onStop = DefaultListenerFunction;
    wifi.onVanish = DefaultListenerFunction;

    wifi.DefaultListenerFunction = DefaultListenerFunction;

    return wifi;
} ());

exports.wifi = wifi;
