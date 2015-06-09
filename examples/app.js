'use strict';
var wifi = require('../build/wifi.min.js').wifi;

var config = {
    interfaces: ['wlan0'],
    interfaceIndex: 0,
    updateFrequency: 10,
    connectionTestFrequency: 2,
    vanishThreshold: 2
};

wifi.start(config).then(        
    function(success) {
        setInterval(function() {
            var list = wifi.list();
            for (var k in list) {
                var n = list[k];
                debugNetworkInfo("list", n);
            }
        }, 2000);
    },
    function(err) {
        console.log(err);
        console.log(err.stack);
    }
);


function debugNetworkInfo(event, network) {
    var quality = Math.floor(network.quality / 70 * 100);

    var ssid = network.ssid || '<HIDDEN>';

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

    console.log("[" + event + "] " + ssid + " [" + network.address + "] " + quality + "% " + network.strength + " dBm " + encryption_type);
}


function connect(networkId, networkSSID, networkPassword) {
    if (!connected && network.ssid === SSID) {
        connected = true;
        wireless.join(network, '', function(err) {
            if (err) {
                console.log("[   ERROR] Unable to connect.");
                return;
            }

            console.log("Yay, we connected! I will try to get an IP.");
            wireless.dhcp(function(ip_address) {
                console.log("Yay, I got an IP address (" + ip_address + ")! I'm going to disconnect in 20 seconds.");

                setTimeout(function() {
                    console.log("20 seconds are up! Attempting to turn off DHCP...");

                    wireless.dhcpStop(function() {
                        console.log("DHCP has been turned off. Leaving the network...");

                        wireless.leave();
                    });
                }, 20 * 1000);
            });
        });
    }
}


wifi.onAppear = function(network) {
    debugNetworkInfo('appear', network);
};


wifi.onVanish = function(network) {
    console.log("[  VANISH] " + network.ssid + " [" + network.address + "] ");
};


wifi.onChange = function(network) {
    console.log("[  CHANGE] " + network.ssid);
};


wifi.onSignal = function(network) {
    console.log("[  SIGNAL] " + network.ssid);
};


wifi.onJoin = function(network) {
    console.log("[    JOIN] " + network.ssid + " [" + network.address + "] ");
};


wifi.onFormer = function(address) {
    console.log("[FORMER] " + address);
};


wifi.onLeave = function() {
    console.log("[   LEAVE] Left the network");
};


wifi.onCommand = function(command) {
    console.log("[ COMMAND] " + command);
};


wifi.onDHCP = function(ip_address) {
    console.log("[    DHCP] Leased IP " + ip_address);
};


wifi.onEmpty = function() {
    console.log("[   EMPTY] Found no networks this scan");
};


var killing_app = false;
process.on('SIGINT', function() {
    console.log("\n");

    if (killing_app) {
        console.log("[PROGRESS] Double SIGINT, Killing without cleanup!");
        process.exit();
    }

    killing_app = true;
    console.log("[PROGRESS] Gracefully shutting down from SIGINT (Ctrl+C)");
    console.log("[PROGRESS] Disabling Adapter...");
/*
    wireless.disable(function() {
        console.log("[PROGRESS] Stopping and Exiting...");

        wireless.stop();
    });*/
});