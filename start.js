process.title = 'domiqtt';

process.on('uncaughtException', function (e) {
	console.log('Uncaught Exception...');
	console.log(e.stack);
	process.exit(99);
});

var nconf = require('nconf'),
		DomiqClient = require('./lib/domiqClient.js'),

		SimpleLogger = require('simple-node-logger'),

		mqtt = require('mqtt'),

		logManager = new SimpleLogger(),
		logger = logManager.createLogger();

main = function () {
	nconf.env('__').argv();
	nconf.file('config', './config.json');

	logManager.createConsoleAppender();

	var initialState = false;
	var domiqClient = new DomiqClient(
			nconf.get('domiq')
	);
	domiqClient.connect();
	domiqClient.on('connect', function () {
		initialState = false;
		logger.info('domiq connected');
	});

	domiqClient.on('close', function () {
		console.log('Connection closed');
	});

	var errorCounter = 0;

	domiqClient.on('error', function (e) {
		console.log('error:', e);
		errorCounter++;
		if (errorCounter > 5) {
			console.log('giving up. exiting.');
			console.log(getDateTime());
			process.exit(1);
		}
		setTimeout(function () {
			domiqClient.connect();
		}, 4000 * errorCounter);
	});

	console.log(nconf.get('mqtt'));
	var mqttClient = mqtt.connect(
			nconf.get('mqtt:url'),
			nconf.get('mqtt:options')
	);
	mqttClient.on('connect', function () {
		logger.info('mqtt connected');
		mqttClient.subscribe(
				nconf.get('mqtt:prefix') + '#'
		);
		mqttClient.publish(nconf.get('mqtt:options:will:topic'), 'online', {retain: true});
	});

	domiqClient.on('event', function (address, value) {
		// TODO ignore events by list

		if (!initialState) {
			initialState = true;
			domiqClient.writeRaw("?");
		}

		logger.info('< domiq', ' ', address, ' = ', value);
		var topic = nconf.get('mqtt:prefix') +
					address.replace(/\./g, '/');

		logger.info('> mqtt', ' ', topic, ' : ', value);
		mqttClient.publish(topic, value, {retain: true});

		var addressParts = address.split('.');
		// 'int' for LED stripes
		if (addressParts[1] === 'output' || addressParts[1] === 'int') {
			mqttClient.publish(topic + '/_brightness_state', value, {retain: true});
			mqttClient.publish(topic + '/_state', value === '0' ? 'OFF' : 'ON', {retain: true});
		}
		if (addressParts[1] === 'relay' || addressParts[1] === 'variable' || addressParts[1] === 'input') {
			mqttClient.publish(topic + '/_state', value === '0' ? 'OFF' : 'ON', {retain: true});
		}
		if (addressParts[1] === 'key' && value === 'hit') {
			setTimeout(function () {
				mqttClient.publish(topic, 'break', {retain: true});
			}, 150);
		}
		var lastElement = addressParts[addressParts.length - 1];
		if (addressParts[1] === 'regulator' || addressParts[1] === 'int') {
			if (lastElement === 'mode') {
				var mode = '';
				if (value === '0') {
					mode = 'auto';
				} else if (value === '1') {
					mode = 'heat';
				} else if (value === '2') {
					mode = 'dry';
				} else if (value === '3') {
					mode = 'fan_only';
				} else if (value === '4') {
					mode = 'cool';
				}
				if (mode !== '') {
					mqttClient.publish(topic + '/_mode', mode, {retain: true});
				}
			} else if (lastElement === 'fan') {
				var mode = '';
				if (value === '0') {
					mode = 'auto';
				} else if (value === '1') {
					mode = 'low';
				} else if (value === '2') {
					mode = 'medium';
				} else if (value === '3') {
					mode = 'high';
				}
				if (mode !== '') {
					mqttClient.publish(topic + '/_fan', mode, {retain: true});
				}
			} else if (lastElement === 'onoff') {
				var mode = '';
				if (value === '0') {
					mode = 'OFF';
				} else if (value === '1') {
					var lastSlashIndex = address.lastIndexOf(".");
					var newAddress = address.substring(0, lastSlashIndex) + ".mode";
					domiqClient.get(newAddress);
				}
				if (mode !== '') {
					var lastSlashIndex = topic.lastIndexOf("/");
					var newTopic = topic.substring(0, lastSlashIndex) + "/mode/_mode";
					mqttClient.publish(newTopic, mode, {retain: true});
					mqttClient.publish(topic + '/_state', mode, {retain: true});
				}
			}
		}
		var nValue = Number(value);
		// 'int' for tempset in AC
		if (addressParts[1] === 'regulator' || (addressParts[1] === 'variable' || addressParts[1] === 'int' && nValue > 800 && nValue < 6000)) {
			mqttClient.publish(topic + '/_c', ((nValue - 1000) / 10).toString(), {retain: true});
			mqttClient.publish(topic + '/_lx', Math.round(Math.exp(nValue/100)).toString(), {retain: true});
		}
	});

	var ignoreNextMessage = {};
	mqttClient.on('message', function (topic, message) {
		logger.info('< mqtt', ' ', topic, ' : ', message.toString());
		var regex = new RegExp('^' + nconf.get('mqtt:prefix'));
		var lastSlashIndex = topic.lastIndexOf("/");
		var specialCommand = topic.substring(lastSlashIndex + 1);

		if (ignoreNextMessage[specialCommand]) {
			ignoreNextMessage[specialCommand] = false;
			return;
		}

		if (specialCommand.substr(0, 1) === '_') {
			topic = topic.substring(0, lastSlashIndex);
			var address = topic
					.replace(regex, '')
					.replace(/\//g, '.');
			var value = message.toString();
			var addressParts = address.split('.');

			switch (specialCommand) {
				case '_get':
					domiqClient.get(address);
					domiqClient.getAge(address, function (age) {
						mqttClient.publish(topic + '/_age', age + "");
					});
					break;

				case '_getAge':
					domiqClient.getAge(address, function (age) {
						mqttClient.publish(topic + '/_age', age + "");
					});

					break;

				case '_set':
					if (message.toString() === 'ON' || message.toString() === 'on') {
						value = 'on';
					}
					else if (message.toString() === 'OFF' || message.toString() === 'off') {
						value = 'off';
					}
					logger.info('> domiq', ' ', address, ' = ', value);
					domiqClient.write(address, value);

					break;

				case '_binary_set':
					if (message.toString() === 'ON' || message.toString() === 'on') {
						value = '1';
					}
					else if (message.toString() === 'OFF' || message.toString() === 'off') {
						value = '0';
					}
					logger.info('> domiq', ' ', address, ' = ', value);
					domiqClient.write(address, value);

					break;

				case '_brightness_set':
					if (message.toString() === 'OFF' || message.toString() === 'off') {
						value = 'off';
					}
					if (addressParts[1] === 'output') {
						value = value + ';ramp:6';
					}
					logger.info('> domiq', ' ', address, ' = ', value);
					domiqClient.write(address, value);

					break;

				case '_led_brightness_set':
					if (message.toString() === 'OFF' || message.toString() === 'off') {
						value = '0';
					}
					var lastSlashIndex = address.lastIndexOf(".");
					var oldVar = address.substring(lastSlashIndex + 1);
					var rawAddress = address.substring(0, lastSlashIndex);

					var valVar = 'dj' + oldVar;
					var valAddress = rawAddress + '.' + valVar;
					logger.info('> domiq', ' ', valAddress, ' = ', value);
					domiqClient.write(valAddress, value);

					var delayValue = '200';
					var delayVar = 'cz' + oldVar;
					var delayAddress = rawAddress + '.' + delayVar;
					logger.info('> domiq', ' ', delayAddress, ' = ', delayValue);
					domiqClient.write(delayAddress, delayValue);

					break;

				case '_mode_set':
					value = message.toString();
					var numValue = '';
					var onValue = '0';
					// heat_cool only for homekit climate control
					if (value === 'auto' || value === 'heat_cool') {
						numValue = '0';
						onValue = '1';
					} else if (value === 'heat') {
						numValue = '1';
						onValue = '1';
					} else if (value === 'dry') {
						numValue = '2';
						onValue = '1';
					} else if (value === 'fan_only') {
						numValue = '3';
						onValue = '1';
					} else if (value === 'cool') {
						numValue = '4';
						onValue = '1';
					}
					
					var lastSlashIndex = address.lastIndexOf(".");
					var newAddress = address.substring(0, lastSlashIndex) + ".onoff";
					logger.info('> domiq', ' ', newAddress, ' = ', onValue);
					domiqClient.write(newAddress, onValue);

					if (numValue !== '') {
						logger.info('> domiq', ' ', address, ' = ', numValue);
						domiqClient.write(address, numValue);
					}
					
					break;

				case '_fan_set':
					value = message.toString();
					if (value === 'auto') {
						value = '0';
					}
					if (value === 'low') {
						value = '1';
					}
					else if (value === 'medium') {
						value = '2';
					}
					else if (value === 'high') {
						value = '3';
					}
					logger.info('> domiq', ' ', address, ' = ', value);
					domiqClient.write(address, value);
					break;

				case '_temp_set':
					value = (Number(value) * 10 + 1000).toString();
					logger.info('> domiq', ' ', address, ' = ', value);
					domiqClient.write(address, value);
					break;

				case '_gate_set':
					if (message.toString() === 'OPEN') {
						logger.info('> domiq', ' ', address, ' = ', '1');
						domiqClient.write(address, 1);
						setTimeout(function () {
							logger.info('> domiq', ' ', address, ' = ', '0');
							domiqClient.write(address, '0');
						}, 200);
					}

					if (message.toString() === 'CLOSE') {
						var newAddressParts = addressParts;
						newAddressParts[4]++;
						var newAddress = newAddressParts.join('.');
						logger.info('> domiq', ' ', newAddress, ' = ', '1');
						domiqClient.write(newAddress, '1');
						setTimeout(function () {
							logger.info('> domiq', ' ', newAddress, ' = ', '0');
							domiqClient.write(newAddress, '0');
						}, 200);
					}
					break;
			}
		}
	})
};

main();
