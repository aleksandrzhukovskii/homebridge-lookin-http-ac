import type { PlatformAccessory, CharacteristicValue } from 'homebridge';
import type { Platform } from './platform.js';
import { SensorPoller } from './sensorPoller.js';

export class AccessoryAC {
  private acState;
  private heaterCooler;
  private fan;

  constructor(
      private readonly platform: Platform,
      private readonly accessory: PlatformAccessory,
      private readonly ip: string,
      poller: SensorPoller,
      private readonly irMap: Record<'low' | 'medium' | 'high', Record<'cool' | 'heat', Record<string, string>>>,
      private readonly off: string,
  ) {
    this.platform.log.debug(JSON.stringify(irMap, null, 4));

    const { Service, Characteristic } = this.platform;
    this.acState = {
      activeFan: false, // INACTIVE
      activeHeaterCooler: 0, //INACTIVE
      mode: 1, // COOL
      heatTemperature: poller.temperature,
      coldTemperature: poller.temperature,
      fanSpeedFan: 2, // 1=Low, 2=Medium, 3=High
      fanSpeedHeaterCooler: 2, // 1=Low, 2=Medium, 3=High
    };

    this.fan = accessory.getService(Service.Fan)
        ?? accessory.addService(Service.Fan, accessory.displayName+' Fan');
    this.fan.updateCharacteristic(Characteristic.RotationSpeed, this.acState.fanSpeedFan);
    this.fan.getCharacteristic(Characteristic.On).onGet(async() => this.acState.activeFan).
      onSet(this.setOn.bind(this));
    this.fan.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 3,
        minStep: 1,
      }).onGet(() => this.acState.fanSpeedFan).onSet(this.setFanSpeed.bind(this));

    this.heaterCooler = accessory.getService(Service.HeaterCooler)
        ?? accessory.addService(Service.HeaterCooler, accessory.displayName);
    this.heaterCooler.updateCharacteristic(Characteristic.TargetHeaterCoolerState, this.acState.mode);
    this.heaterCooler.updateCharacteristic(Characteristic.CoolingThresholdTemperature, this.acState.coldTemperature);
    this.heaterCooler.updateCharacteristic(Characteristic.HeatingThresholdTemperature, this.acState.heatTemperature);
    this.heaterCooler.updateCharacteristic(Characteristic.RotationSpeed, this.acState.fanSpeedHeaterCooler);
    this.heaterCooler.updateCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.heaterCooler.getCharacteristic(Characteristic.TemperatureDisplayUnits).onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.heaterCooler.getCharacteristic(Characteristic.Active).onGet(() => this.acState.activeHeaterCooler).onSet(this.setActive.bind(this));
    this.heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).onGet(this.getCurrentHeaterCoolerState.bind(this));
    this.heaterCooler.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [Characteristic.TargetHeaterCoolerState.HEAT, Characteristic.TargetHeaterCoolerState.COOL] })
      .onGet(() => this.acState.mode).onSet(this.setMode.bind(this));
    this.heaterCooler.getCharacteristic(Characteristic.CurrentTemperature).onGet(async () => poller.temperature);
    this.heaterCooler.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({
      minValue: 16,
      maxValue: 30,
      minStep: 1,
    })
      .onGet(() => this.acState.coldTemperature).onSet(this.setColdTemperature.bind(this));
    this.heaterCooler.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({
      minValue: 16,
      maxValue: 30,
      minStep: 1,
    })
      .onGet(() => this.acState.heatTemperature).onSet(this.setHeatTemperature.bind(this));
    this.heaterCooler.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 3,
        minStep: 1,
      }).onGet(() => this.acState.fanSpeedHeaterCooler).onSet(this.setHeaterCoolerSpeed.bind(this));

    poller.on('update', () => {
      this.heaterCooler.updateCharacteristic(Characteristic.CurrentTemperature, poller.temperature);
    });
  }

  async getCurrentHeaterCoolerState(): Promise<number> {
    const { CurrentHeaterCoolerState } = this.platform.Characteristic;
    if (this.acState.activeHeaterCooler === 0) {
      return CurrentHeaterCoolerState.IDLE;
    }
    if (this.acState.mode === 1) {
      return CurrentHeaterCoolerState.HEATING;
    }
    return CurrentHeaterCoolerState.COOLING;
  }

  async setActive(value: CharacteristicValue) {
    const { Characteristic } = this.platform;
    if (this.acState.activeHeaterCooler===value){
      return;
    }
    this.acState.activeHeaterCooler = value as number;
    this.platform.log.debug(`[${this.accessory.displayName}] Set Active Heater -> ${value as number}`);
    if ((this.acState.activeFan?1:0)!==this.acState.activeHeaterCooler){
      await this.sendAcCommand();
    }
    this.fan.updateCharacteristic(Characteristic.On, value===1);
    await this.setOn(value===1);
  }

  async setMode(value: CharacteristicValue) {
    this.acState.mode = value as number;
    this.platform.log.debug(`[${this.accessory.displayName}] Set Mode -> ${value === 1 ? 'HEAT' : 'COOL'}`);
    await this.sendAcCommand();
  }

  async setColdTemperature(value: CharacteristicValue) {
    const val = value as number;
    this.acState.coldTemperature = val>=16?val:16;
    this.platform.log.debug(`[${this.accessory.displayName}] Set Cold Temperature -> ${val}`);
    if (this.acState.activeHeaterCooler===1 && this.acState.mode===this.platform.Characteristic.TargetHeaterCoolerState.COOL){
      await this.sendAcCommand();
    }
  }

  async setHeatTemperature(value: CharacteristicValue) {
    const val = value as number;
    this.acState.heatTemperature = val>=16?val:16;
    this.platform.log.debug(`[${this.accessory.displayName}] Set Heat Temperature -> ${val}`);
    if (this.acState.activeHeaterCooler===1 && this.acState.mode===this.platform.Characteristic.TargetHeaterCoolerState.HEAT){
      await this.sendAcCommand();
    }
  }

  async setFanSpeed(value: CharacteristicValue) {
    const { Characteristic } = this.platform;
    if (this.acState.fanSpeedFan===value || value===0){
      return;
    }
    this.acState.fanSpeedFan = value as number;
    const speedLabel = ['Low', 'Medium', 'High'][this.acState.fanSpeedFan-1];
    this.platform.log.debug(`[${this.accessory.displayName}] Set Fan Speed Fan -> ${speedLabel}`);

    if (this.acState.fanSpeedFan!==this.acState.fanSpeedHeaterCooler){
      await this.sendAcCommand();
    }
    this.heaterCooler.updateCharacteristic(Characteristic.RotationSpeed, value);
    await this.setHeaterCoolerSpeed(value);
  }

  async setHeaterCoolerSpeed(value: CharacteristicValue) {
    const { Characteristic } = this.platform;
    if (this.acState.fanSpeedHeaterCooler===value || value===0){
      return;
    }
    this.acState.fanSpeedHeaterCooler = value as number;
    const speedLabel = ['Low', 'Medium', 'High'][this.acState.fanSpeedHeaterCooler-1];
    this.platform.log.debug(`[${this.accessory.displayName}] Set Fan Speed Heater -> ${speedLabel}`);

    if (this.acState.fanSpeedFan!==this.acState.fanSpeedHeaterCooler){
      await this.sendAcCommand();
    }
    this.fan.updateCharacteristic(Characteristic.RotationSpeed, value);
    await this.setFanSpeed(value);
  }

  async setOn(value: CharacteristicValue) {
    const { Characteristic } = this.platform;
    if (this.acState.activeFan===value) {
      return;
    }
    this.acState.activeFan = value as boolean;
    this.platform.log.debug(`[${this.accessory.displayName}] Set Active Fan -> ${value as boolean}`);
    if ((this.acState.activeFan?1:0)!==this.acState.activeHeaterCooler){
      await this.sendAcCommand();
    }
    this.heaterCooler.updateCharacteristic(Characteristic.Active, value?1:0);
    await this.setActive(value?1:0);
  }

  private async sendAcCommand(): Promise<void> {
    let code='';
    if (this.acState.activeHeaterCooler === 1) {
      const modeStr = this.acState.mode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT ? 'heat' : 'cool';
      const temp = this.acState.mode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT
        ? this.acState.heatTemperature
        : this.acState.coldTemperature;

      const fanSpeedStr = ['low', 'medium', 'high'][this.acState.fanSpeedFan - 1] as 'low' | 'medium' | 'high';
      code = this.irMap?.[fanSpeedStr]?.[modeStr]?.[`t${temp}`];

      if (!code) {
        this.platform.log.warn(`[${this.accessory.displayName}] No IR code for ${fanSpeedStr}/${modeStr}/${temp}`);
        return;
      }
    }else{
      code=this.off;
    }

    const url = `http://${this.ip}/commands/ir/prontohex/${code}`;
    this.platform.log.debug(`[${this.accessory.displayName}] Sending IR code: ${url}`);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        this.platform.log.error(`[${res.status}] Failed to send IR code`);
      }
    } catch (err) {
      this.platform.log.error(`[${this.accessory.displayName}] Failed to send IR code: ${err}`);
    }
  }
}
