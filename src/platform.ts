import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { AccessoryAC } from './acAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { EveHomeKitTypes } from 'homebridge-lib/EveHomeKitTypes';
import { SensorPoller } from './sensorPoller.js';
import { TemperatureAccessory } from './temperatureAccessory.js';
import { HumidityAccessory } from './humidityAccessory.js';

export class Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomServices: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.CustomServices = new EveHomeKitTypes(this.api).Services;
    this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    for (const accessory of this.accessories.values()) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.accessories.clear();

    const devices = this.config.devices;
    if (!Array.isArray(devices)) {
      this.log.warn('No devices configured under "devices" in platform config.');
      return;
    }

    for (const device of devices) {
      if (!device.name) {
        this.log.warn('Skipping device without "name":', device);
        continue;
      }

      this.log.info('Adding new accessory:', device.name);
      const sensorPoller = new SensorPoller(device.ip, device.name, this.log);
      //Temperature
      const uuidTemp = this.api.hap.uuid.generate(device.name+' Temperature Sensor');
      const accessoryTemp = new this.api.platformAccessory(device.name+' Temperature Sensor', uuidTemp);
      new TemperatureAccessory(this, accessoryTemp, sensorPoller);

      //Humidity
      const uuidHum = this.api.hap.uuid.generate(device.name+' Humidity Sensor');
      const accessoryHum = new this.api.platformAccessory(device.name+' Humidity Sensor', uuidHum);
      new HumidityAccessory(this, accessoryHum, sensorPoller);

      //AC
      const uuidAC = this.api.hap.uuid.generate(device.name);
      const accessoryAC = new this.api.platformAccessory(device.name, uuidAC);
      new AccessoryAC(this, accessoryAC, device.ip, sensorPoller, device.irMap, device.off, device.debug, device.reqNum);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessoryTemp, accessoryHum, accessoryAC]);
    }
  }
}
