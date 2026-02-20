import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import si from 'systeminformation';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3838;
const SETTINGS_FILE = join(__dirname, '../settings.json');

const log = {
  info: (...args) => console.log(`[INFO] ${new Date().toISOString()}`, ...args),
  error: (...args) => console.error(`[ERROR] ${new Date().toISOString()}`, ...args),
  warn: (...args) => console.warn(`[WARN] ${new Date().toISOString()}`, ...args),
};

app.use(cors());
app.use(express.static(join(__dirname, '../public')));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 1000,
  max: 10,
  message: { error: 'Too many requests, please slow down' },
});
app.use('/api/', limiter);

function validateTdp(watts) {
  const w = parseInt(watts);
  if (isNaN(w) || w < 5 || w > 65) {
    return { valid: false, error: 'TDP must be between 5-65 watts' };
  }
  return { valid: true, value: w };
}

function validateBatteryLimit(percent) {
  const p = parseInt(percent);
  if (isNaN(p) || p < 20 || p > 100) {
    return { valid: false, error: 'Battery limit must be between 20-100%' };
  }
  return { valid: true, value: p };
}

function validateFanProfile(profile) {
  const validProfiles = ['silent', 'balanced', 'performance'];
  if (!validProfiles.includes(profile)) {
    return { valid: false, error: `Fan profile must be one of: ${validProfiles.join(', ')}` };
  }
  return { valid: true, value: profile };
}

function validatePowerMode(mode) {
  const validModes = ['battery-saver', 'balanced', 'max'];
  if (!validModes.includes(mode)) {
    return { valid: false, error: `Power mode must be one of: ${validModes.join(', ')}` };
  }
  return { valid: true, value: mode };
}

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
    this.windowsPowerAvailable = false;
    this.powerPlans = {};
    this.activePowerPlan = 'balanced';
    this.lastCpuTemp = 0;
    this.lastGpuTemp = 0;
    this.cpuInfo = null;
    this.gpuInfo = null;
    this.fanSpeeds = [];
    this.coreTemps = [];
    this.tempHistory = [];
    this.powerHistory = [];
    this.maxHistoryLength = 60; // 60 seconds of history
  }

  async init() {
    console.log('Initializing hardware interface...');
    await this.checkCapabilities();

    // Apply saved settings on startup
    if (this.ryzenAdjAvailable) {
      console.log('Applying saved TDP limit:', settings.tdpLimit);
      await this.setTdpLimit(settings.tdpLimit);
    } else if (this.windowsPowerAvailable) {
      console.log('Applying saved power mode:', settings.powerMode);
      await this.setPowerMode(settings.powerMode);
    }
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

      // Initialize Windows native power control
      await this.initWindowsPower();
    } catch (e) {
      console.error('Could not get CPU info:', e.message);
    }
  }

  // ============================================
  // Windows Native Power Control
  // ============================================

  // Helper to run PowerShell commands
  async runPsCommand(command) {
    const { stdout } = await execAsync(`powershell.exe -NoProfile -Command "${command}"`, { timeout: 10000 });
    return stdout;
  }

  async initWindowsPower() {
    try {
      // Get available power plans using PowerShell
      const stdout = await this.runPsCommand('powercfg /list');

      // Parse power plan GUIDs
      const planRegex = /Power Scheme GUID:\s*([a-f0-9-]+)\s+\(([^)]+)\)/gi;
      let match;
      while ((match = planRegex.exec(stdout)) !== null) {
        const guid = match[1];
        const name = match[2].toLowerCase();
        this.powerPlans[name] = guid;
      }

      // Check if we have the standard plans
      if (Object.keys(this.powerPlans).length > 0) {
        this.windowsPowerAvailable = true;
        console.log('Windows Power Control: Available');
        console.log('Available plans:', Object.keys(this.powerPlans).join(', '));
      }

      // Create custom power plans if needed
      await this.ensureCustomPlans();
    } catch (e) {
      console.log('Windows Power Control: Not available:', e.message);
    }
  }

  async ensureCustomPlans() {
    // Create High Performance plan if not exists
    if (!this.powerPlans['high performance']) {
      try {
        // Duplicate balanced plan and rename to High Performance
        const balancedGuid = this.powerPlans['balanced'];
        if (balancedGuid) {
          await this.runPsCommand(`powercfg /duplicatescheme ${balancedGuid}`);
          // Re-scan to get the new plan
          const stdout = await this.runPsCommand('powercfg /list');
          const planRegex = /Power Scheme GUID:\s*([a-f0-9-]+)\s+\(([^)]+)\)/gi;
          let match;
          while ((match = planRegex.exec(stdout)) !== null) {
            const guid = match[1];
            const name = match[2].toLowerCase();
            if (!this.powerPlans[name]) {
              this.powerPlans[name] = guid;
            }
          }
        }
      } catch (e) {
        console.log('Could not create High Performance plan:', e.message);
      }
    }
  }

  async getCurrentPowerPlan() {
    try {
      const stdout = await this.runPsCommand('powercfg /getactivescheme');
      const match = stdout.match(/Power Scheme GUID:\s*([a-f0-9-]+)\s+\(([^)]+)\)/i);
      if (match) {
        return { guid: match[1], name: match[2].toLowerCase() };
      }
    } catch (e) {
      // Ignore
    }
    return null;
  }

  async setPowerPlan(planName) {
    const guid = this.powerPlans[planName];
    if (!guid) {
      console.error('Power plan not found:', planName);
      return { success: false, error: 'Power plan not found' };
    }

    try {
      await this.runPsCommand(`powercfg /setactive ${guid}`);
      this.activePowerPlan = planName;
      console.log('Switched to power plan:', planName);
      return { success: true, plan: planName };
    } catch (e) {
      console.error('Failed to set power plan:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Set CPU minimum and maximum processor state (0-100%)
  async setCpuThrottle(minPercent, maxPercent) {
    try {
      // Get current active scheme
      const current = await this.getCurrentPowerPlan();
      if (!current) return { success: false, error: 'Could not get active power plan' };

      const guid = current.guid;

      // AC power settings
      await this.runPsCommand(`powercfg /setacvalueindex ${guid} SUB_PROCESSOR PROCTHROTTLEMIN ${minPercent}`);
      await this.runPsCommand(`powercfg /setacvalueindex ${guid} SUB_PROCESSOR PROCTHROTTLEMAX ${maxPercent}`);

      // DC (battery) power settings
      await this.runPsCommand(`powercfg /setdcvalueindex ${guid} SUB_PROCESSOR PROCTHROTTLEMIN ${minPercent}`);
      await this.runPsCommand(`powercfg /setdcvalueindex ${guid} SUB_PROCESSOR PROCTHROTTLEMAX ${maxPercent}`);

      // Apply the changes
      await this.runPsCommand(`powercfg /setactive ${guid}`);

      console.log(`CPU throttle set: ${minPercent}% - ${maxPercent}%`);
      return { success: true, min: minPercent, max: maxPercent };
    } catch (e) {
      console.error('Failed to set CPU throttle:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Enable or disable CPU turbo boost
  async setCpuBoost(enabled) {
    try {
      const current = await this.getCurrentPowerPlan();
      if (!current) return { success: false, error: 'Could not get active power plan' };

      const guid = current.guid;
      // 0 = disabled, 2 = enabled (boost on)
      const boostValue = enabled ? 2 : 0;

      // Set boost policy for AC and DC
      await this.runPsCommand(`powercfg /setacvalueindex ${guid} SUB_PROCESSOR PERFBOOSTMODE ${boostValue}`);
      await this.runPsCommand(`powercfg /setdcvalueindex ${guid} SUB_PROCESSOR PERFBOOSTMODE ${boostValue}`);

      // Apply changes
      await this.runPsCommand(`powercfg /setactive ${guid}`);

      console.log('CPU boost set:', enabled ? 'enabled' : 'disabled');
      return { success: true, enabled };
    } catch (e) {
      console.error('Failed to set CPU boost:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Map TDP watts to CPU throttle percentage
  tdpToThrottlePercent(tdp) {
    // Approximate mapping for Ryzen 7 7840HS (35-54W base, up to 65W boost)
    // Lower TDP = lower max frequency = lower percentage
    const minTdp = 5;
    const maxTdp = 65;
    const percent = Math.round(((tdp - minTdp) / (maxTdp - minTdp)) * 70 + 30); // 30-100%
    return Math.max(30, Math.min(100, percent));
  }

  // Set power mode using Windows native controls
  async setPowerMode(mode) {
    console.log('Setting power mode:', mode);

    let result = { success: true, mode };

    switch (mode) {
      case 'battery-saver':
        // Switch to power saver plan
        if (this.powerPlans['power saver']) {
          await this.setPowerPlan('power saver');
        }
        // Limit CPU to 50% max, disable boost
        await this.setCpuThrottle(5, 50);
        await this.setCpuBoost(false);
        settings.tdpLimit = 15;
        settings.fanProfile = 'silent';
        settings.boostEnabled = false;
        break;

      case 'balanced':
        // Switch to balanced plan
        if (this.powerPlans['balanced']) {
          await this.setPowerPlan('balanced');
        }
        // Allow CPU up to 90%, boost enabled
        await this.setCpuThrottle(5, 90);
        await this.setCpuBoost(true);
        settings.tdpLimit = 45;
        settings.fanProfile = 'balanced';
        settings.boostEnabled = true;
        break;

      case 'max':
        // Switch to high performance plan
        if (this.powerPlans['high performance']) {
          await this.setPowerPlan('high performance');
        } else if (this.powerPlans['ultimate performance']) {
          await this.setPowerPlan('ultimate performance');
        }
        // Allow CPU 100%, boost enabled
        await this.setCpuThrottle(5, 100);
        await this.setCpuBoost(true);
        settings.tdpLimit = 65;
        settings.fanProfile = 'performance';
        settings.boostEnabled = true;
        break;

      default:
        result.success = false;
        result.error = 'Unknown power mode';
    }

    settings.powerMode = mode;
    saveSettings();

    // Also try RyzenAdj if available
    if (this.ryzenAdjAvailable) {
      await this.setTdpLimit(settings.tdpLimit);
    }

    return result;
  }

  // Get all sensor data
  async getSensors() {
    try {
      const [cpuLoad, mem, battery, network, cpuTempData] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.battery(),
        si.networkStats().catch(() => []),
        si.cpuTemperature().catch(() => ({})),
      ]);

      const cpuTemp = await this.getCpuTemp();
      const gpuData = await this.getGpuData();
      const fanData = await this.getFanData();

      // Store core temperatures
      if (cpuTempData.cores && cpuTempData.cores.length > 0) {
        this.coreTemps = cpuTempData.cores.map(t => Math.round(t));
      } else {
        // Estimate core temps based on average
        this.coreTemps = Array(8).fill(0).map(() =>
          Math.round(cpuTemp + (Math.random() * 10 - 5))
        );
      }

      // Add to temperature history
      this.tempHistory.push({
        timestamp: Date.now(),
        cpu: cpuTemp,
        gpu: gpuData.temperature || 0,
      });
      if (this.tempHistory.length > this.maxHistoryLength) {
        this.tempHistory.shift();
      }

      // Add to power history
      const tdpCurrent = this.estimateTdp(cpuLoad.currentLoad);
      this.powerHistory.push({
        timestamp: Date.now(),
        current: tdpCurrent,
        limit: settings.tdpLimit,
      });
      if (this.powerHistory.length > this.maxHistoryLength) {
        this.powerHistory.shift();
      }

      return {
        timestamp: Date.now(),
        cpu: {
          temperature: cpuTemp,
          load: Math.round(cpuLoad.currentLoad * 10) / 10,
          cores: cpuLoad.cpus?.slice(0, 8).map(c => Math.round(c.load * 10) / 10) || [],
          coreTemps: this.coreTemps,
          brand: this.cpuInfo?.brand || 'Unknown',
          physicalCores: this.cpuInfo?.physicalCores || 8,
        },
        gpu: gpuData,
        fan: fanData,
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
          acConnected: battery.acConnected,
        },
        network: {
          download: network[0]?.rx_sec || 0,
          upload: network[0]?.tx_sec || 0,
          interface: network[0]?.iface || 'N/A',
        },
        power: {
          tdpCurrent: tdpCurrent,
          tdpLimit: settings.tdpLimit,
        },
        tempHistory: this.tempHistory,
        powerHistory: this.powerHistory,
        settings: { ...settings },
        version: '1.0.0',
      };
    } catch (e) {
      console.error('Sensor error:', e);
      return { error: e.message, timestamp: Date.now() };
    }
  }

  async getFanData() {
    try {
      // Try to get fan speeds from systeminformation
      const fans = await si.cpuTemperature();

      // Most systems don't report fan speed directly
      // Return estimated fan speed based on temperature and profile
      const baseSpeed = {
        'silent': 25,
        'balanced': 35,
        'performance': 50,
      }[settings.fanProfile] || 35;

      // Estimate fan speed based on CPU temperature
      let estimatedSpeed = baseSpeed;
      const lastTemp = this.lastCpuTemp || 50;

      if (lastTemp > 80) estimatedSpeed = 100;
      else if (lastTemp > 70) estimatedSpeed = 80;
      else if (lastTemp > 60) estimatedSpeed = 60;
      else if (lastTemp > 50) estimatedSpeed = 45;
      else estimatedSpeed = baseSpeed;

      return {
        available: true,
        speed: estimatedSpeed,
        profile: settings.fanProfile,
        rpm: estimatedSpeed * 30, // Rough RPM estimate
      };
    } catch {
      return {
        available: false,
        speed: 0,
        profile: settings.fanProfile,
        rpm: 0,
      };
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

  // TDP control (uses RyzenAdj if available, otherwise Windows power control)
  async setTdpLimit(watts) {
    console.log('Setting TDP limit:', watts);
    settings.tdpLimit = Math.min(Math.max(watts, 5), 65);

    // Execute RyzenAdj for actual TDP control if available
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
    } else if (this.windowsPowerAvailable) {
      // Use Windows power control as fallback
      const maxPercent = this.tdpToThrottlePercent(settings.tdpLimit);
      await this.setCpuThrottle(5, maxPercent);
      console.log(`Windows Power: Set CPU max to ${maxPercent}% (TDP ~${settings.tdpLimit}W equivalent)`);
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

    // Use Windows power control to actually set boost
    if (this.windowsPowerAvailable) {
      await this.setCpuBoost(enabled);
    }

    return { success: true, boostEnabled: settings.boostEnabled };
  }
}

const hw = new HardwareInterface();

// ============================================
// REST API Routes
// ============================================

app.get('/api/sensors', async (req, res) => {
  const data = await hw.getSensors();
  res.json(data);
});

app.get('/api/settings', (req, res) => {
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  settings = { ...settings, ...req.body };
  saveSettings();
  res.json({ success: true, settings });
});

app.get('/api/system-info', async (req, res) => {
  try {
    const [cpu, os, mem, graphics] = await Promise.all([
      si.cpu(),
      si.osInfo(),
      si.mem(),
      si.graphics(),
    ]);

    res.json({
      cpu: {
        brand: cpu.brand,
        cores: cpu.cores,
        physicalCores: cpu.physicalCores,
        speed: cpu.speed,
      },
      os: {
        platform: os.platform,
        distro: os.distro,
        release: os.release,
        arch: os.arch,
      },
      memory: {
        total: mem.total,
      },
      graphics: graphics.controllers?.map(g => ({
        model: g.model,
        vendor: g.vendor,
        memory: g.memoryTotal,
      })) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fan-profile', async (req, res) => {
  try {
    const { profile } = req.body;
    const validation = validateFanProfile(profile);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    const result = await hw.setFanProfile(validation.value);
    saveSettings();
    res.json(result);
  } catch (e) {
    log.error('Fan profile error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/tdp', async (req, res) => {
  try {
    const { watts } = req.body;
    const validation = validateTdp(watts);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    const result = await hw.setTdpLimit(validation.value);
    saveSettings();
    res.json(result);
  } catch (e) {
    log.error('TDP error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/battery-limit', async (req, res) => {
  try {
    const { percent } = req.body;
    const validation = validateBatteryLimit(percent);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    const result = await hw.setBatteryLimit(validation.value);
    saveSettings();
    res.json(result);
  } catch (e) {
    log.error('Battery limit error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/power-mode', async (req, res) => {
  try {
    const { mode } = req.body;
    const validation = validatePowerMode(mode);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    const result = await hw.setPowerMode(validation.value);
    saveSettings();
    res.json(result);
  } catch (e) {
    log.error('Power mode error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/boost', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Boost must be a boolean' });
    }
    const result = await hw.setBoostEnabled(enabled);
    saveSettings();
    res.json(result);
  } catch (e) {
    log.error('Boost error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================
// WebSocket for Real-time Updates
// ============================================

const clients = new Set();

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);

  // Send initial data
  hw.getSensors().then(data => {
    ws.send(JSON.stringify({ type: 'sensors', data }));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });
});

// Broadcast sensor updates every 1 second
setInterval(async () => {
  if (clients.size === 0) return;

  const data = await hw.getSensors();
  const message = JSON.stringify({ type: 'sensors', data });

  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}, 1000);

// ============================================
// Start Server
// ============================================

hw.init().then(() => {
  server.listen(PORT, () => {
    console.log('SERVER_READY');
    console.log(`
╔═══════════════════════════════════════════════╗
║     Framework Control Web Portal              ║
║                                               ║
║     Open in browser: http://localhost:${PORT}   ║
╚═══════════════════════════════════════════════╝
    `);
  });
});
