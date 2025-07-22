import type { PlatformAccessory } from 'homebridge';
import type { Platform } from './platform.js';
import { SensorPoller } from './sensorPoller.js';

export class TemperatureAccessory {
  constructor(
    platform: Platform,
    accessory: PlatformAccessory,
    poller: SensorPoller,
  ) {
    const { Service, Characteristic } = platform;
    const temperatureSensor = accessory.getService(Service.TemperatureSensor)
          ?? accessory.addService(Service.TemperatureSensor, `${accessory.displayName}`);
    temperatureSensor.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(async () => poller.temperature);

    poller.on('update', () => {
      temperatureSensor.updateCharacteristic(Characteristic.CurrentTemperature, poller.temperature);
    });
  }
}
