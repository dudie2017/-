# Brooks Radar - Design System

## Product Identity
A professional futures market monitoring terminal based on Al Brooks Price Action methodology. Think of it as a **military-grade radar screen** for commodity futures - scanning 66 varieties across Chinese exchanges, detecting trend reversals, breakouts, and traps in real-time.

## Visual Anchor
**Night vision HUD in a futures trading command center.** Dark backgrounds with phosphor-green and cyan data overlays. The feeling of watching a radar sweep across enemy territory - each futures variety is a blip on the screen, and when something important happens, it flashes bright.

## Design Style: Cyber Tech (Dark Terminal)

### Color Palette
| Token | Value | Meaning |
|-------|-------|---------|
| Background | `#0A0A0F` | Deep space black - the void of the market |
| Surface | `#12121A` | Card background - slightly lifted from void |
| Primary | `#00F0FF` | Electric cyan - active signals, AI direction |
| Secondary | `#BF00FF` | Neon purple - secondary indicators |
| Bull/Buy | `#00FF88` | Matrix green - bullish signals, long direction |
| Bear/Sell | `#FF003C` | Danger red - bearish signals, short direction |
| Warning | `#FFB800` | Amber - caution, oversold alerts |
| Text Primary | `#EAEAEA` | Near-white - main data |
| Text Secondary | `#555570` | Muted gray - labels, descriptions |
| Border | `rgba(0,240,255,0.12)` | Subtle cyan glow - card boundaries |

### Typography
- Data numbers: Monospace feel, bold, large (the "radar readout")
- Labels: Small, uppercase, letter-spaced (military HUD style)
- Headers: Bold, clean, no decoration

### Core Visual Techniques
1. **Neon glow borders** - Cards have subtle cyan border glow
2. **Color-coded signals** - Green for bull, red for bear, cyan for neutral
3. **Compact data density** - Show maximum information per screen
4. **Status indicators** - Pulsing dots, colored badges for spectrum/AI direction

### Navigation
- Bottom Tab Bar with 3 tabs: Market Scan | Alerts | Settings
- Dark tab bar with cyan active state glow
- Sharp, angular icon style

### Component Style
- Cards: borderRadius 8, subtle cyan border glow
- Buttons: Sharp corners (borderRadius 6), neon borders
- Data cells: Compact, monospace numbers, color-coded
- Badges: Small pill shapes with glow effect

### Design Don'ts
- No rounded, soft, friendly UI - this is a professional tool
- No pastel colors - only high-contrast neon on black
- No large illustrations or illustrations at all
- No white backgrounds anywhere

---

## Training Module - Brooks Price Action 训练系统

### Product Identity
A gamified trading training simulator based on Al Brooks Price Action methodology. Think of it as a **combat simulation terminal** - traders practice reading real market data, making decisions bar-by-bar, and receiving Brooks-style coaching feedback. The training module uses the same dark terminal aesthetic as the radar, but adds gaming elements (levels, scores, achievements) to create an engaging learning experience.

### Visual Anchor
**Flight simulator cockpit for futures traders.** Real historical K-line data rendered as a tactical chart, with the trader making decisions under pressure. Each level is a "mission" through a real market scenario - the chart unfolds bar by bar, and the trader must identify setups, enter positions, and manage risk just as they would in live trading.

### Training-Specific Colors (extends base palette)
| Token | Value | Meaning |
|-------|-------|---------|
| Level Locked | `#2A2A3A` | Unavailable level - dim, inactive |
| Level Available | `#00F0FF` | Ready to play - cyan glow |
| Level Cleared | `#00FF88` | Completed - green success |
| Star Active | `#FFB800` | Achievement star - amber gold |
| Training Accent | `#BF00FF` | Special training highlight |
| Score S | `#FFD700` | Perfect score - gold |
| Score A | `#00FF88` | Excellent - green |
| Score B | `#00F0FF` | Good - cyan |
| Score C | `#FFB800` | Pass - amber |

### Training Components
- **K-Line Chart**: Custom SVG candlestick chart with EMA20 overlay, volume/OI sub-chart. Real data only.
- **Level Cards**: Compact grid cells with level number, variety name, difficulty badge, star rating
- **Action Buttons**: 做多(green) / 做空(red) / 观望(amber) / 平仓(white) - large, tappable
- **Brooks Tip Panel**: Cyan-bordered card with coaching text, bulb icon
- **Progress Bars**: Neon-filled bars for XP/level progression
- **Achievement Badges**: Hexagonal badges with glow effect

### Training Navigation
- 训练首页 (entry from radar) → 剧情闯关 / 专项训练 / 个人中心
- Stack navigation (no tabs) - training flows linearly like missions
- K-line chart is the hero element - takes 60% of screen height

### Training Design Don'ts
- No fake/simulated data - all K-line data must be real historical market data
- No bright/white backgrounds - maintain dark terminal aesthetic
- No simplified charts - show full OHLC candles with volume
- No disconnected UI - training stats must persist and reflect actual progress
