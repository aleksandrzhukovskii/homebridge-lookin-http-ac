import type { PlatformAccessory, CharacteristicValue } from 'homebridge';
import type { Platform } from './platform.js';
import { SensorPoller } from './sensorPoller.js';

export class AccessoryAC {
  private acState: {
    activeFan: boolean;
    activeHeaterCooler: number;
    mode: number;
    heatTemperature: number;
    coldTemperature: number;
    fanSpeedFan: number;
    fanSpeedHeaterCooler: number;
  };
  private heaterCooler;
  private fan;
  private contactSensor;
  private debounceTimer: NodeJS.Timeout | null = null;
  private contactTimer: NodeJS.Timeout | null = null;
  private pendingCommand: string | null = null;

  constructor(
      private readonly platform: Platform,
      private readonly accessory: PlatformAccessory,
      private readonly ip: string,
      poller: SensorPoller,
      private readonly irMap: Record<'low' | 'medium' | 'high', Record<'cool' | 'heat', Record<string, string>>>,
      private readonly off: string,
      private readonly debug: boolean,
      private readonly reqNum: number,
  ) {
    if (this.debug) {
      this.platform.log.warn(JSON.stringify(irMap, null, 4));
    }

    const { Service, Characteristic } = this.platform;

    this.acState = {
      activeFan: false,
      activeHeaterCooler: 0,
      mode: this.platform.Characteristic.TargetHeaterCoolerState.COOL,
      heatTemperature: poller.temperature,
      coldTemperature: poller.temperature,
      fanSpeedFan: 2,
      fanSpeedHeaterCooler: 2,
    };

    // Heater/Cooler service
    this.heaterCooler =
        accessory.getService(Service.HeaterCooler) ??
        accessory.addService(Service.HeaterCooler, accessory.displayName);
    this.heaterCooler.updateCharacteristic(Characteristic.TargetHeaterCoolerState, this.acState.mode);
    this.heaterCooler.updateCharacteristic(Characteristic.CoolingThresholdTemperature, this.acState.coldTemperature);
    this.heaterCooler.updateCharacteristic(Characteristic.HeatingThresholdTemperature, this.acState.heatTemperature);
    this.heaterCooler.updateCharacteristic(Characteristic.RotationSpeed, this.acState.fanSpeedHeaterCooler);
    this.heaterCooler.updateCharacteristic(
      Characteristic.TemperatureDisplayUnits,
      Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    this.heaterCooler
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.heaterCooler
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.acState.activeHeaterCooler)
      .onSet(this.setActive.bind(this));

    this.heaterCooler
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentHeaterCoolerState.bind(this));

    this.heaterCooler
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          Characteristic.TargetHeaterCoolerState.HEAT,
          Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(() => this.acState.mode)
      .onSet(this.setMode.bind(this));

    this.heaterCooler
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(async () => poller.temperature);

    this.heaterCooler
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
      .onGet(() => this.acState.coldTemperature)
      .onSet(this.setColdTemperature.bind(this));

    this.heaterCooler
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
      .onGet(() => this.acState.heatTemperature)
      .onSet(this.setHeatTemperature.bind(this));

    this.heaterCooler
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 3, minStep: 1 })
      .onGet(() => this.acState.fanSpeedHeaterCooler)
      .onSet(this.setHeaterCoolerSpeed.bind(this));

    // Fan service
    this.fan =
        accessory.getService(Service.Fan) ??
        accessory.addService(Service.Fan, accessory.displayName + ' Fan');

    this.fan.updateCharacteristic(Characteristic.RotationSpeed, this.acState.fanSpeedFan);

    this.fan
      .getCharacteristic(Characteristic.On)
      .onGet(async () => this.acState.activeFan)
      .onSet(this.setOn.bind(this));

    this.fan
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 3, minStep: 1 })
      .onGet(() => this.acState.fanSpeedFan)
      .onSet(this.setFanSpeed.bind(this));

    this.heaterCooler.addLinkedService(this.fan);

    // Contact Sensor service
    this.contactSensor =
        accessory.getService(Service.ContactSensor) ??
        accessory.addService(Service.ContactSensor, accessory.displayName + ' Contact');

    this.contactSensor.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );

    // Poller updates current temperature
    poller.on('update', () => {
      this.heaterCooler.updateCharacteristic(Characteristic.CurrentTemperature, poller.temperature);
    });

    // Start contact sensor polling
    void this.pollContactSensor();
    this.contactTimer = setInterval(() => void this.pollContactSensor(), 60_000);

    // Clean up timers
    this.platform.api?.on?.('shutdown', () => {
      if (this.contactTimer) {
        clearInterval(this.contactTimer);
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
    });
    this.heaterCooler.setPrimaryService(true);
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
    this.acState.activeHeaterCooler = value as number;
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Set Active Heater -> ${value as number}`);
    }
    await this.sendAcCommand();

    this.fan.updateCharacteristic(Characteristic.On, value === 1);
  }

  async setMode(value: CharacteristicValue) {
    this.acState.mode = value as number;
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Set Mode -> ${value === 1 ? 'HEAT' : 'COOL'}`);
    }
    await this.sendAcCommand();
  }

  async setColdTemperature(value: CharacteristicValue) {
    const val = value as number;
    this.acState.coldTemperature = val >= 16 ? val : 16;
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Set Cold Temperature -> ${val}`);
    }
    if (
      this.acState.activeHeaterCooler === 1 &&
      this.acState.mode === this.platform.Characteristic.TargetHeaterCoolerState.COOL
    ) {
      await this.sendAcCommand();
    }
  }

  async setHeatTemperature(value: CharacteristicValue) {
    const val = value as number;
    this.acState.heatTemperature = val >= 16 ? val : 16;
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Set Heat Temperature -> ${val}`);
    }
    if (
      this.acState.activeHeaterCooler === 1 &&
      this.acState.mode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT
    ) {
      await this.sendAcCommand();
    }
  }

  async setFanSpeed(value: CharacteristicValue) {
    const { Characteristic } = this.platform;

    if ((value as number) === 0) {
      if (this.debug) {
        this.platform.log.warn(`[${this.accessory.displayName}] Ignoring Fan Speed 0 (no IR code mapping)`);
      }
      return;
    }

    this.acState.fanSpeedFan = value as number;
    this.acState.fanSpeedHeaterCooler = value as number;

    const speedLabel = ['Low', 'Medium', 'High'][this.acState.fanSpeedFan - 1];
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Set Fan Speed -> ${speedLabel}`);
    }


    this.fan.updateCharacteristic(Characteristic.RotationSpeed, value);
    this.heaterCooler.updateCharacteristic(Characteristic.RotationSpeed, value);

    await this.sendAcCommand();
  }

  async setHeaterCoolerSpeed(value: CharacteristicValue) {
    const { Characteristic } = this.platform;

    if ((value as number) === 0) {
      if (this.debug) {
        this.platform.log.warn(`[${this.accessory.displayName}] Ignoring HeaterCooler Speed 0 (no IR code mapping)`);
      }
      return;
    }

    this.acState.fanSpeedHeaterCooler = value as number;
    this.acState.fanSpeedFan = value as number;

    const speedLabel = ['Low', 'Medium', 'High'][this.acState.fanSpeedHeaterCooler - 1];
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Set Fan Speed (Heater) -> ${speedLabel}`);
    }

    this.heaterCooler.updateCharacteristic(Characteristic.RotationSpeed, value);
    this.fan.updateCharacteristic(Characteristic.RotationSpeed, value);

    await this.sendAcCommand();
  }

  async setOn(value: CharacteristicValue) {
    const { Characteristic } = this.platform;
    this.acState.activeFan = value as boolean;
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Set Active Fan -> ${value as boolean}`);
    }

    this.heaterCooler.updateCharacteristic(Characteristic.Active, value ? 1 : 0);
    await this.setActive(value ? 1 : 0);
  }

  private async pollContactSensor(): Promise<void> {
    const { Characteristic } = this.platform;
    const url = `http://${this.ip}`;
    try {
      const res = await fetch(url);
      let detected = false;
      if (res.status === 200) {
        const text = (await res.text()).trim();
        detected = text === 'OK';
      }
      const state = detected
        ? Characteristic.ContactSensorState.CONTACT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;

      this.contactSensor.updateCharacteristic(Characteristic.ContactSensorState, state);

      if (this.debug) {
        this.platform.log.warn(`[${this.accessory.displayName}] Contact Sensor -> ${detected ? 'CONTACT_DETECTED' : 'CONTACT_NOT_DETECTED'}`);
      }
    } catch (err) {
      this.contactSensor.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      );
      this.platform.log.error(`[${this.accessory.displayName}] Contact poll failed: ${err}`);
    }
  }

  private async sendAcCommand(): Promise<void> {
    let code = '';
    if (this.acState.activeHeaterCooler === 1) {
      const modeStr =
          this.acState.mode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT
            ? 'heat'
            : 'cool';
      const temp =
          this.acState.mode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT
            ? this.acState.heatTemperature
            : this.acState.coldTemperature;

      const fanSpeedStr = ['low', 'medium', 'high'][this.acState.fanSpeedFan - 1] as
          | 'low'
          | 'medium'
          | 'high';
      code = this.irMap?.[fanSpeedStr]?.[modeStr]?.[`t${temp}`];

      if (!code) {
        this.platform.log.warn(`[${this.accessory.displayName}] No IR code for ${fanSpeedStr}/${modeStr}/${temp}`);
        return;
      }
    } else {
      code = this.off;
    }

    this.pendingCommand = code;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (this.pendingCommand) {
        void this.performSend(this.pendingCommand);
        this.pendingCommand = null;
      }
    }, 500);
  }

  private async performSend(code: string): Promise<void> {
    const url = `http://${this.ip}/commands/ir/prontohex/${code}`;
    if (this.debug) {
      this.platform.log.warn(`[${this.accessory.displayName}] Sending IR code (x${this.reqNum}): ${url}`);
    }

    for (let i = 0; i < this.reqNum; i++) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          this.platform.log.error(`[${res.status}] Failed to send IR code (attempt ${i + 1}/${this.reqNum})`);
        } else if (this.debug) {
          this.platform.log.warn(`[${this.accessory.displayName}] IR code sent (attempt ${i + 1}/${this.reqNum})`);
        }
      } catch (err) {
        this.platform.log.error(`[${this.accessory.displayName}] Failed to send IR code (attempt ${i + 1}/${this.reqNum}): ${err}`);
      }

      if (i+1 < this.reqNum) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
}
