import type { PlatformAccessory } from 'homebridge';
import type { Platform } from './platform.js';
import { SensorPoller } from './sensorPoller.js';

export class HumidityAccessory {
  constructor(
    platform: Platform,
    accessory: PlatformAccessory,
    poller: SensorPoller,
  ) {
    const { Service, Characteristic } = platform;
    const humiditySensor = accessory.getService(Service.HumiditySensor)
          ?? accessory.addService(Service.HumiditySensor, `${accessory.displayName}`);
    humiditySensor.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(async () => poller.humidity);

    poller.on('update', () => {
      humiditySensor.updateCharacteristic(Characteristic.CurrentRelativeHumidity, poller.humidity);
    });
  }
}
