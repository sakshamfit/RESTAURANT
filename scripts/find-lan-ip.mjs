#!/usr/bin/env node
import os from 'os';

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const out = [];
  const seen = new Set();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (seen.has(info.address)) continue;
      seen.add(info.address);
      const isVirtual = /virtual|vmware|hyper-v|hyperv|docker|wsl|veth|tunnel|tap|tun|loopback|pseudo|bridge|br-/i.test(name);
      const isUtun = /^utun\d+$/i.test(name);
      let rangePriority = 10;
      if (info.address.startsWith('192.168.')) rangePriority = 0;
      else if (info.address.startsWith('10.')) rangePriority = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) rangePriority = 2;
      else if (info.address.startsWith('169.254.')) rangePriority = 100;
      let priority = rangePriority + (isVirtual ? 50 : 0) + (isUtun ? 60 : 0);
      if (/^(en0|eth0|wlan0|wi-fi|wifi|wlp)/i.test(name)) priority -= 5;
      out.push({ address: info.address, interface: name, priority, isVirtual, isUtun });
    }
  }
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

const addrs = getLanAddresses();
console.log('\n=== NEXORAOSP RESTAURANT — LAN IP Finder ===\n');
if (addrs.length === 0) {
  console.log('No LAN IPv4 detected!');
  console.log('Connect this PC to Wi-Fi/Ethernet, then run again.');
  console.log('\nOn Windows, run: ipconfig');
  console.log('On Mac/Linux, run: ifconfig | grep 192.168');
  process.exit(1);
}

console.log('Found LAN addresses (best first):\n');
addrs.forEach((a, i) => {
  const best = i === 0 ? ' ← BEST (use this for QR)' : '';
  console.log(`  ${i + 1}. ${a.address} (${a.interface})${best}`);
});

const best = addrs[0];
const port = process.env.PORT || 3000;

console.log(`\n=== QR will use: http://${best.address}:${port} ===\n`);
console.log('How to use:');
console.log('\n1. For web build (npm):');
console.log(`   Create .env file with:`);
console.log(`     APP_URL=http://${best.address}:${port}`);
console.log(`     HOST=0.0.0.0`);
console.log(`     PORT=${port}`);
console.log(`   Then: npm run build && npm start`);
console.log(`\n   OR on PowerShell (Windows):`);
console.log(`     $env:APP_URL="http://${best.address}:${port}"; $env:HOST="0.0.0.0"; $env:PORT="${port}"; npm start`);
console.log(`\n   OR on CMD (Windows):`);
console.log(`     set APP_URL=http://${best.address}:${port} && set HOST=0.0.0.0 && set PORT=${port} && npm start`);
console.log(`\n2. For desktop app:`);
console.log(`   The app auto-detects this IP. Just ensure staff PC and phone are on same Wi-Fi.`);
console.log(`   If QR still shows 127.0.0.1, set QR Base URL in Admin → Settings to:`);
console.log(`     http://${best.address}:${port}`);
console.log(`\n3. Test QR URL:`);
console.log(`     http://${best.address}:${port}/order/nexoraosp_tbl_tok_table1_9a2f7c`);
console.log(`   Open this on your phone (same Wi-Fi) — should load menu.\n`);
