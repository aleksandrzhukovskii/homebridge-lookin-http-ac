import { EventEmitter } from 'events';
import http from 'http';
import type { Logging } from 'homebridge';

export class SensorPoller extends EventEmitter {
  public temperature = 24;
  public humidity = 50;

  private intervalHandle?: NodeJS.Timeout;

  constructor(private readonly ip: string, private readonly name: string,
              private readonly log: Logging , private readonly intervalMs = 30000) {
    super();
    this.startPolling();
  }

  private startPolling(): void {
    this.intervalHandle = setInterval(() => this.fetchSensorData(), this.intervalMs);
    this.fetchSensorData();
  }

  private fetchSensorData(): void {
    const url = `http://${this.ip}/sensors/meteo`;

    http.get(url, res => {
      let rawData = '';

      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          const temp = parseFloat(parsed.Temperature);
          const hum = parseFloat(parsed.Humidity);

          if (!isNaN(temp)) {
            this.temperature = temp;
          }
          if (!isNaN(hum)) {
            this.humidity = hum;
          }

          this.emit('update');
        } catch (err){
          this.log.warn(`[${this.name}] Sensor update failed: ${err}`);
        }
      });
    }).on('error', err => {
      this.log.warn(`[${this.name}] Sensor update failed: ${err}`);
    });
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }
}