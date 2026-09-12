# Keymux 🚀

**The Local Proxy for Claude Code — Use Claude Code for Free!**

Keymux is a lightweight local proxy that lets you use **Claude Code** (CLI, Desktop App, or IDE Extension) without paying for Anthropic credits. It acts as a middleman, intercepting Claude Code's native requests and translating them to use free or cheaper open-source models from providers like Groq, Mistral, OpenRouter, and more.

If you have a bunch of free-tier API keys, Keymux will smartly pool them together, balancing the load so you never hit a rate limit while coding.

## 🎯 What Does It Do?

- **Native Claude Code Support:** Works seamlessly with the Claude Code CLI, Claude Desktop App, and Claude IDE Extensions.
- **Multi-Provider Magic:** Automatically translates Anthropic-formatted tool calls (like file edits and bash commands) to work with:
  - ⚡ Groq (LPU)
  - 🧠 Mistral
  - 🌐 OpenRouter
  - 🟢 Nvidia NIM
  - 🔮 Google Gemini
- **Multi-Key Multiplexing:** Add 5 different Groq keys, and Keymux will balance the traffic across all of them to bypass free-tier rate limits.
- **Zero-Downtime Failover:** If an API key hits a rate limit (429) mid-request, Keymux silently translates the model name and retries on a different provider before Claude Code even notices.
- **Cyberpunk Terminal Dashboard:** Run `keymux -d` to see a beautiful, live-updating TUI (Terminal UI) showing your active keys, network latency, and routing stats.

## 🧠 How It Routes Traffic (The Smart Selection)

Keymux doesn't just pick keys randomly. It uses a **Smart TTFT (Time To First Token)** algorithm:
1. **Speed First:** It constantly pings your providers to check their latency.
2. **Fast Pool:** It groups all keys that respond within a +100ms tolerance band.
3. **Least Utilized:** From that fast pool, it picks the key that has been used the *least* recently (Lowest RPM).
4. **Result:** You always get the fastest response without burning out a single API key.

---

## 🛠️ Installation & Setup

### 1. Build and Link
Clone the repository and link it globally so you can run the `keymux` command anywhere.
```bash
git clone https://github.com/Mayank332k/keymux.git
cd keymux
npm install
npm run build
npm link
```

### 2. Configure Your Keys
Keymux will automatically create a configuration file at `~/.keymux/config.json`.
You can add your free-tier API keys for whichever providers you want to use.

### 3. Start the Proxy Daemon
Start the Keymux local server in the background. It runs locally on port 3002.
```bash
keymux start --port 3002
```
*(To stop it later, just run `keymux stop`)*

### 4. Connect Claude Code
Tell Claude Code to send its requests to your local Keymux proxy instead of Anthropic's servers. 

Just open your `.bashrc` or `.zshrc` and add this alias:
```bash
alias free-claude='export ANTHROPIC_API_KEY="dummy-key" && export ANTHROPIC_BASE_URL="http://127.0.0.1:3002/v1" && claude'
```
Now, just type `free-claude` in your terminal, and you're coding for free!

---

## 🖥️ The Dashboard

Want to see what's happening under the hood? Run the interactive dashboard:
```bash
keymux -d
```
This will open the TUI where you can monitor API health, change default models, and watch the load balancer in real-time.

---
*Made for developers who want the Claude Code experience locally, without the enterprise price tag.*