import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import si from 'systeminformation';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3838;
const SETTINGS_FILE = join(__dirname, '../settings.json');

// Serve static files
app.use(express.static(join(__dirname, '../public')));
app.use(express.json());

// Default settings
const defaultSettings = {
  powerMode: 'balanced',
  fanProfile: 'balanced',
  tdpLimit: 45,
  batteryLimit: 100,
  boostEnabled: true,
  startMinimized: false,
  closeToTray: true,
  checkUpdates: true,
};

// Load settings from file
function loadSettings() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const data = readFileSync(SETTINGS_FILE, 'utf8');
      return { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('Failed to load settings:', e.message);
  }
  return { ...defaultSettings };
}

// Save settings to file
function saveSettings() {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e.message);
  }
}

let settings = loadSettings();

const powerModePresets = {
  'battery-saver': { tdpLimit: 15, fanProfile: 'silent', boostEnabled: false },
  'balanced': { tdpLimit: 45, fanProfile: 'balanced', boostEnabled: true },
  'max': { tdpLimit: 65, fanProfile: 'performance', boostEnabled: true },
};

// ============================================
// Hardware Interface Layer
// ============================================

class HardwareInterface {
  constructor() {
    this.ecAvailable = false;
    this.ryzenAdjAvailable = false;
    this.lastCpuTemp = 0;
    this.lastGpuTemp = 0;
    this.cpuInfo = null;
    this.gpuInfo = null;
  }

  async init() {
    console.log('Initializing hardware interface...');
    await this.checkCapabilities();
  }

  async checkCapabilities() {
    try {
      const cpu = await si.cpu();
      console.log('CPU:', cpu.brand);
      this.cpuInfo = cpu;

      // Get GPU info
      try {
        const graphics = await si.graphics();
        if (graphics.controllers && graphics.controllers.length > 0) {
          // Find dedicated GPU first, then integrated
          const dedicated = graphics.controllers.find(g =>
            g.vendor && !g.vendor.toLowerCase().includes('intel') &&
            (g.model?.toLowerCase().includes('nvidia') ||
             g.model?.toLowerCase().includes('radeon') ||
             g.model?.toLowerCase().includes('amd'))
          );
          this.gpuInfo = dedicated || graphics.controllers[0];
          console.log('GPU:', this.gpuInfo.model);
        }
      } catch (e) {
        console.log('GPU info not available');
      }

      // Check for RyzenAdj in multiple locations
      const ryzenAdjPaths = [
        'RyzenAdj.exe',  // In PATH
        join(process.resourcesPath || '', 'resources', 'ryzenadj', 'RyzenAdj.exe'),  // Bundled with app
        join(dirname(__dirname), 'resources', 'ryzenadj', 'RyzenAdj.exe'),  // Dev mode
        'C:\\Program Files\\RyzenAdj\\RyzenAdj.exe',
        'C:\\RyzenAdj\\RyzenAdj.exe',
        join(process.env.USERPROFILE || '', 'RyzenAdj', 'RyzenAdj.exe'),
      ];

      for (const ryzenAdjPath of ryzenAdjPaths) {
        try {
          await execAsync(`"${ryzenAdjPath}" --help`, { timeout: 3000 });
          this.ryzenAdjPath = ryzenAdjPath;
          this.ryzenAdjAvailable = true;
          console.log('RyzenAdj: Found at', ryzenAdjPath);
          break;
        } catch {
          // Try next path
        }
      }

      if (!this.ryzenAdjAvailable) {
        console.log('RyzenAdj: Not found. Download from https://github.com/FlyGoat/RyzenAdj/releases');
        console.log('Place RyzenAdj.exe in: resources/ryzenadj/');
      }
    } catch (e) {
      console.error('Could not get CPU info:', e.message);
    }
  }

  // Get all sensor data
  async getSensors() {
    try {
      const [cpuLoad, mem, battery, network] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.battery(),
        si.networkStats().catch(() => []),
      ]);

      const cpuTemp = await this.getCpuTemp();
      const gpuData = await this.getGpuData();

      return {
        timestamp: Date.now(),
        cpu: {
          temperature: cpuTemp,
          load: Math.round(cpuLoad.currentLoad * 10) / 10,
          cores: cpuLoad.cpus?.slice(0, 8).map(c => Math.round(c.load * 10) / 10) || [],
          brand: this.cpuInfo?.brand || 'Unknown',
        },
        gpu: gpuData,
        memory: {
          used: mem.used,
          total: mem.total,
          percentage: Math.round((mem.used / mem.total) * 100 * 10) / 10,
          free: mem.free,
          swapUsed: mem.swapused,
          swapTotal: mem.swaptotal,
        },
        battery: {
          percent: battery.percent || 0,
          isCharging: battery.isCharging || false,
          timeRemaining: battery.timeRemaining,
          capacity: battery.currentCapacity,
          maxCapacity: battery.maxCapacity,
          designedCapacity: battery.designedCapacity,
          cycleCount: battery.cycleCount,
          health: this.calculateBatteryHealth(battery),
          voltage: battery.voltage,
        },
        network: {
          download: network[0]?.rx_sec || 0,
          upload: network[0]?.tx_sec || 0,
          interface: network[0]?.iface || 'N/A',
        },
        power: {
          tdpCurrent: this.estimateTdp(cpuLoad.currentLoad),
          tdpLimit: settings.tdpLimit,
        },
        settings: { ...settings },
      };
    } catch (e) {
      console.error('Sensor error:', e);
      return { error: e.message, timestamp: Date.now() };
    }
  }

  async getGpuData() {
    if (!this.gpuInfo) {
      return { available: false };
    }

    try {
      const graphics = await si.graphics();
      const current = graphics.controllers?.find(g => g.model === this.gpuInfo.model) || this.gpuInfo;

      return {
        available: true,
        model: current.model || 'Unknown',
        vendor: current.vendor || 'Unknown',
        temperature: current.temperatureGpu || this.lastGpuTemp || 0,
        memoryTotal: current.memoryTotal || 0,
        memoryUsed: current.memoryUsed || 0,
        memoryFree: (current.memoryTotal || 0) - (current.memoryUsed || 0),
        utilization: current.utilizationGpu || 0,
      };
    } catch {
      return { available: false };
    }
  }

  calculateBatteryHealth(battery) {
    if (!battery.maxCapacity || !battery.designedCapacity) return null;
    return Math.round((battery.maxCapacity / battery.designedCapacity) * 100);
  }

  async getCpuTemp() {
    // Try WMI first (works on Windows without admin)
    try {
      const { stdout } = await execAsync(
        'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature /value 2>nul',
        { timeout: 2000 }
      );
      const match = stdout.match(/CurrentTemperature=(\d+)/);
      if (match) {
        // WMI returns temperature in tenths of Kelvin
        const tempK = parseInt(match[1]) / 10;
        const tempC = Math.round(tempK - 273.15);
        if (tempC > 0 && tempC < 150) {
          this.lastCpuTemp = tempC;
          return tempC;
        }
      }
    } catch {
      // WMI not available, try alternative
    }

    // Try systeminformation
    try {
      const temps = await si.cpuTemperature();
      if (temps.main && temps.main > 0) {
        this.lastCpuTemp = temps.main;
        return temps.main;
      }
    } catch {
      // Ignore
    }

    // Fallback: estimate from load (rough approximation)
    const load = await si.currentLoad();
    const estimatedTemp = 35 + (load.currentLoad * 0.4);

    // Smooth the temperature changes
    if (this.lastCpuTemp === 0) {
      this.lastCpuTemp = Math.round(estimatedTemp);
    } else {
      // Move towards estimated temp slowly
      this.lastCpuTemp = Math.round(this.lastCpuTemp * 0.9 + estimatedTemp * 0.1);
    }

    return this.lastCpuTemp;
  }

  estimateTdp(load) {
    // Rough TDP estimation based on load percentage
    const maxTdp = settings.tdpLimit;
    return Math.round((load / 100) * maxTdp);
  }

  // Fan control (requires EC access or vendor tools)
  async setFanProfile(profile) {
    console.log('Setting fan profile:', profile);
    settings.fanProfile = profile;

    // In production, this would:
    // 1. Write to EC registers for Framework laptops
    // 2. Or use platform-specific APIs

    // For Framework laptops, fan curves are set via EC:
    // - Profile: 'silent', 'balanced', 'performance'
    // - Custom: Array of { temp, speed } points

    return { success: true, profile };
  }

  // TDP control (requires RyzenAdj for AMD)
  async setTdpLimit(watts) {
    console.log('Setting TDP limit:', watts);
    settings.tdpLimit = Math.min(Math.max(watts, 5), 65);

    // Execute RyzenAdj for actual TDP control
    if (this.ryzenAdjAvailable && this.ryzenAdjPath) {
      try {
        const mw = settings.tdpLimit * 1000;
        // STAPM = skin temperature aware power management (sustained)
        // FAST = fast limit (burst)
        // SLOW = slow limit
        await execAsync(
          `"${this.ryzenAdjPath}" --stapm-limit=${mw} --fast-limit=${mw} --slow-limit=${mw}`,
          { timeout: 5000 }
        );
        console.log(`RyzenAdj: Set TDP to ${settings.tdpLimit}W`);
      } catch (e) {
        console.error('RyzenAdj error:', e.message);
        return { success: false, error: e.message, tdpLimit: settings.tdpLimit };
      }
    }

    return { success: true, tdpLimit: settings.tdpLimit };
  }

  // Get current TDP from RyzenAdj
  async getTdpInfo() {
    if (!this.ryzenAdjAvailable || !this.ryzenAdjPath) return null;

    try {
      const { stdout } = await execAsync(`"${this.ryzenAdjPath}" --info`, { timeout: 5000 });
      // Parse output for current TDP values
      const stapmMatch = stdout.match(/STAPM LIMIT:\s*(\d+)/i);
      const fastMatch = stdout.match(/FAST LIMIT:\s*(\d+)/i);

      return {
        stapmLimit: stapmMatch ? parseInt(stapmMatch[1]) / 1000 : null,
        fastLimit: fastMatch ? parseInt(fastMatch[1]) / 1000 : null,
      };
    } catch (e) {
      console.error('RyzenAdj info error:', e.message);
      return null;
    }
  }

  // Battery charge limit (requires EC access)
  async setBatteryLimit(percent) {
    console.log('Setting battery limit:', percent);
    settings.batteryLimit = Math.min(Math.max(percent, 20), 100);

    // In production, write to EC:
    // Framework EC uses specific registers for charge limit

    return { success: true, batteryLimit: settings.batteryLimit };
  }

  // CPU Boost control
  async setBoostEnabled(enabled) {
    console.log('Setting CPU boost:', enabled);
    settings.boostEnabled = enabled;

    // In production, use Windows power plans or registry:
    // powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 100
    // Or AMD: RyzenMaster.exe or reg