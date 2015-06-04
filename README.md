# blueocean-wifi-js
Wifi manipulation utility for BlueOcean devices

Requires grunt and grunt-cli.

## Usage

    'use strict';
    var wifi = require('wifi.min.js').wifi;

    var config = {
        interfaces: ['wlan0'],
        interfaceIndex: 0,
        updateFrequency: 10,
        connectionTestFrequency: 2,
        vanishThreshold: 2
    };

    // Callback when a network is detected
    wifi.onAppear = function(network) {
        console.log("Network appeared with essid: " + network.essid);
    };

    // Start the wifi system
    wifi.start(config).then(        
        function(success) {
            console.log("Yay!")
        },
        function(err) {
            console.log("Boo!")
        }
    );