// Waits for the server to be ready by polling the .port file and testing the connection.
// Used by the dev script to ensure Vite doesn't start before the server port is known.
const fs = require('fs');
const net = require('net');
const path = require('path');

const portFile = path.join(__dirname, '..', '.port');
const TIMEOUT = 15000;
const start = Date.now();

// Delete stale port file so we wait for the server to write a fresh one
try { fs.unlinkSync(portFile); } catch {}

function check() {
  if (Date.now() - start > TIMEOUT) {
    console.error('Timed out waiting for server to start');
    process.exit(1);
  }

  let port;
  try {
    port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
  } catch {
    setTimeout(check, 150);
    return;
  }

  if (!port || isNaN(port)) {
    setTimeout(check, 150);
    return;
  }

  // Verify the server is actually accepting connections
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.destroy();
    console.log(`Server ready on port ${port}`);
    process.exit(0);
  });
  sock.on('error', () => setTimeout(check, 150));
}

check();
