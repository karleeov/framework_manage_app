# Framework Control

A Windows desktop application for managing Framework laptop power, fan, and battery settings.

![Framework Control Screenshot](https://via.placeholder.com/800x450?text=Framework+Control+Dashboard)

## Download

### Latest Release: v1.0.0

| Version | Download | Size |
|---------|----------|------|
| **Portable** | [Framework Control 1.0.0.exe](https://github.com/YOUR_USERNAME/framework-control/releases/download/v1.0.0/Framework.Control.1.0.0.exe) | ~74 MB |
| **Installer** | [Framework Control Setup 1.0.0.exe](https://github.com/YOUR_USERNAME/framework-control/releases/download/v1.0.0/Framework.Control.Setup.1.0.0.exe) | ~74 MB |

> **Note**: Replace `YOUR_USERNAME` with your GitHub username after uploading to GitHub Releases.

### System Requirements
- Windows 10/11 (x64)
- No installation required for portable version
- Works on any laptop (Framework features work best on Framework laptops)

## Features

### Real-time Monitoring
- CPU temperature, load, and per-core stats
- GPU temperature and utilization
- Fan speed (RPM and percentage)
- Battery health, cycles, and voltage
- Memory usage
- Network statistics

### Power Management
| Mode | CPU Limit | Boost | Use Case |
|------|-----------|-------|----------|
| Battery Saver | 50% | OFF | Maximum battery life |
| Balanced | 90% | ON | Everyday use |
| Max Performance | 100% | ON | Gaming, heavy workloads |

### Additional Controls
- **TDP Slider**: Adjust power limit (5W - 65W)
- **CPU Boost Toggle**: Enable/disable turbo boost
- **Fan Profiles**: Silent, Balanced, Performance
- **Battery Protection**: Set charge limit (20% - 100%)

### System Integration
- Minimizes to system tray
- Settings persist between sessions
- Auto-starts with saved power mode

## Quick Start

1. **Download** the portable exe or installer above
2. **Run** `Framework Control.exe`
3. **Open** the dashboard (auto-opens in browser)
4. **Select** your power mode and adjust settings

## Development

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/framework-control.git
cd framework-control

# Install dependencies
npm install

# Run in development mode
npm run electron:dev

# Build for distribution
npm run electron:build
```

## Technology Stack

- **Frontend**: HTML, CSS, JavaScript (vanilla)
- **Backend**: Node.js, Express, WebSocket
- **Desktop**: Electron
- **Hardware**: Windows powercfg, WMI, systeminformation

## Architecture

```
┌─────────────────────────────────────────────┐
│              Electron App                    │
├─────────────────────────────────────────────┤
│  ┌──────────────┐      ┌────────────────┐   │
│  │   Frontend   │◄────►│    Backend     │   │
│  │   (Browser)  │ WS   │ (Express+WS)   │   │
│  └──────────────┘      └───────┬────────┘   │
│                                │            │
│                      ┌─────────▼─────────┐  │
│                      │   Hardware API    │  │
│                      │  - Windows powercfg  │
│                      │  - WMI (temps)    │  │
│                      │  - systeminformation │
│                      │  - RyzenAdj (optional) │
│                      └───────────────────┘  │
└─────────────────────────────────────────────┘
```

## Optional: RyzenAdj Integration

For exact TDP control (instead of CPU throttle %), download [RyzenAdj](https://github.com/FlyGoat/RyzenAdj/releases) and place `RyzenAdj.exe` in:
```
resources/ryzenadj/RyzenAdj.exe
```

## Roadmap

- [ ] Auto-start on Windows boot
- [ ] Custom fan curves
- [ ] Per-application power profiles
- [ ] Battery charge limit (Framework EC)
- [ ] Linux support

## License

MIT License - Feel free to use, modify, and distribute.

## Credits

- Inspired by [Framework Community](https://community.frame.work/)
- Hardware monitoring by [systeminformation](https://github.com/sebhildebrandt/systeminformation)
- TDP control optional via [RyzenAdj](https://github.com/FlyGoat/RyzenAdj)
