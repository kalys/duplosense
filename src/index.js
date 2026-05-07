import { Dualsense } from "dualsense-ts";
import { interval, animationFrameScheduler } from "rxjs";

// --- LPF2 BLE Constants ---
const LPF2_SERVICE = "00001623-1212-efde-1623-785feabcd123";
const LPF2_CHARACTERISTIC = "00001624-1212-efde-1623-785feabcd123";
const MOTOR_PORT = 0x00;
const DEVICE_TYPE_SPEAKER = 42;

// Duplo Train Base sounds (from LPF2 protocol)
const SOUND_BRAKE = 3;
const SOUND_STATION = 5;
const SOUND_HORN = 9;
const SOUND_STEAM = 10;

// --- Physics Constants ---
const ACCEL_RATE = 60;       // power units/sec when accelerating
const DECEL_RATE = 120;      // power units/sec when braking (2x accel)
const POWER_PER_LEVEL = 20;  // each cruise level = 20% power
const STICK_DEADZONE = 0.1;
const BLE_INTERVAL_MS = 200; // resend motor command every 200ms to keep alive

// --- State ---
let controller = null;
const bleChars = [null, null]; // raw BLE characteristics per train
const speakerPorts = [null, null]; // discovered speaker port per train
const writeQueues = [Promise.resolve(), Promise.resolve()]; // serialize BLE writes per train
let activeTrain = 0;
const trains = [
  { cruiseLevel: 0, power: 0 },
  { cruiseLevel: 0, power: 0 },
];
const prev = {
  dpadUp: false, dpadDown: false, l1: false, r1: false,
  cross: false, circle: false, square: false, triangle: false,
};
const lastSent = [{ power: null, time: 0 }, { power: null, time: 0 }];

// --- Helpers ---
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function rampPower(current, target, dt) {
  const diff = target - current;
  if (Math.abs(diff) < 0.5) return target;

  const movingTowardZero = Math.abs(current + Math.sign(diff)) < Math.abs(current);
  const rate = movingTowardZero ? DECEL_RATE : ACCEL_RATE;

  const step = rate * dt;
  if (Math.abs(diff) <= step) return target;
  return current + Math.sign(diff) * step;
}

// Queued BLE write to avoid GATT races
function bleWrite(slot, cmd) {
  const char = bleChars[slot];
  if (!char) return;
  writeQueues[slot] = writeQueues[slot]
    .then(() => char.writeValueWithoutResponse(cmd))
    .catch(() => {});
}

function sendMotorPower(slot, power) {
  const p = power & 0xFF;
  bleWrite(slot, new Uint8Array([0x08, 0x00, 0x81, MOTOR_PORT, 0x11, 0x51, 0x00, p]));
}

function sendSound(slot, port, sound) {
  bleWrite(slot, new Uint8Array([0x08, 0x00, 0x81, port, 0x11, 0x51, 0x01, sound]));
}

// --- Logging ---
function log(msg) {
  const el = document.getElementById("console");
  if (!el) return;
  el.innerHTML += `${msg}<br/>`;
  el.scrollTop = el.scrollHeight;
}

// --- UI ---
function updateStatus() {
  for (let i = 0; i < 2; i++) {
    const el = document.getElementById(`train${i + 1}-status`);
    if (el) el.textContent = bleChars[i] ? "Connected" : "—";
  }
  const cel = document.getElementById("controller-status");
  if (cel) cel.textContent = controller ? "Connected" : "—";
}

function updateLive() {
  for (let i = 0; i < 2; i++) {
    const n = i + 1;
    const cel = document.getElementById(`train${n}-cruise`);
    const pel = document.getElementById(`train${n}-power`);
    const card = document.getElementById(`train${n}-card`);
    const badge = document.getElementById(`train${n}-badge`);
    if (cel) cel.textContent = trains[i].cruiseLevel;
    if (pel) pel.textContent = Math.round(trains[i].power);
    if (card) card.classList.toggle("active", i === activeTrain);
    if (badge) badge.style.display = i === activeTrain ? "inline-block" : "none";
  }
}

// --- Connections ---
export async function connectTrain(slot) {
  if (!navigator.bluetooth) {
    alert("Web Bluetooth is not supported in this browser.");
    return;
  }

  try {
    const bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [LPF2_SERVICE] }],
      optionalServices: ["battery_service", "device_information"],
    });
    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(LPF2_SERVICE);
    const char = await service.getCharacteristic(LPF2_CHARACTERISTIC);

    // Listen for device attachment messages to discover speaker port
    char.addEventListener("characteristicvaluechanged", (event) => {
      const data = new Uint8Array(event.target.value.buffer);
      if (data[2] === 0x04 && data[4] === 0x01) {
        const portId = data[3];
        const deviceType = data[5] | (data[6] << 8);
        if (deviceType === DEVICE_TYPE_SPEAKER) {
          speakerPorts[slot] = portId;
          bleWrite(slot, new Uint8Array([0x0A, 0x00, 0x41, portId, 0x01, 0x01, 0x00, 0x00, 0x00, 0x01]));
        }
      }
    });
    await char.startNotifications();

    log(`Connected to ${bleDevice.name} as Train ${slot + 1}`);
    bleChars[slot] = char;
    updateStatus();

    bleDevice.addEventListener("gattserverdisconnected", () => {
      log(`Train ${slot + 1} disconnected`);
      bleChars[slot] = null;
      updateStatus();
    });
  } catch (e) {
    log(`Train ${slot + 1} error: ${e.message}`);
    console.error(e);
  }
}

export function connectController() {
  if (!navigator.hid) {
    alert("WebHID is not supported in this browser.");
    return;
  }

  controller = new Dualsense();
  controller.connection.on("change", () => {
    log(`Controller ${controller.connection.state ? "connected" : "disconnected"}`);
    updateStatus();
  });

  const requestHandler = controller.hid.provider.getRequest();
  requestHandler();
}

// --- Game loop ---
function startLoop() {
  let lastTime = performance.now();

  interval(0, animationFrameScheduler).subscribe(() => {
    if (!controller) return;

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    // --- Read inputs ---
    const dpadUp = !!controller.dpad.up.state;
    const dpadDown = !!controller.dpad.down.state;
    const l1 = !!controller.left.bumper.state;
    const r1 = !!controller.right.bumper.state;
    const stickY = controller.right.analog.y.state || 0; // up = positive
    const cross = !!controller.cross.state;
    const circle = !!controller.circle.state;
    const square = !!controller.square.state;
    const triangle = !!controller.triangle.state;

    const stickActive = Math.abs(stickY) > STICK_DEADZONE;

    // --- Edge detection ---
    const dpadUpEdge = dpadUp && !prev.dpadUp;
    const dpadDownEdge = dpadDown && !prev.dpadDown;
    const l1Edge = l1 && !prev.l1;
    const r1Edge = r1 && !prev.r1;
    const crossEdge = cross && !prev.cross;
    const circleEdge = circle && !prev.circle;
    const squareEdge = square && !prev.square;
    const triangleEdge = triangle && !prev.triangle;
    prev.dpadUp = dpadUp;
    prev.dpadDown = dpadDown;
    prev.l1 = l1;
    prev.r1 = r1;
    prev.cross = cross;
    prev.circle = circle;
    prev.square = square;
    prev.triangle = triangle;

    // --- Train selection ---
    if (l1Edge && activeTrain !== 0) {
      activeTrain = 0;
      log("→ Train 1");
    }
    if (r1Edge && activeTrain !== 1) {
      activeTrain = 1;
      log("→ Train 2");
    }

    // --- Face buttons: sounds ---
    const spkPort = speakerPorts[activeTrain];
    if (bleChars[activeTrain] && spkPort !== null) {
      if (crossEdge) {
        trains[activeTrain].cruiseLevel = 0;
        trains[activeTrain].power = 0;
        sendMotorPower(activeTrain, 0);
        sendSound(activeTrain, spkPort, SOUND_BRAKE);
      }
      if (circleEdge) sendSound(activeTrain, spkPort, SOUND_STEAM);
      if (squareEdge) sendSound(activeTrain, spkPort, SOUND_HORN);
      if (triangleEdge) sendSound(activeTrain, spkPort, SOUND_STATION);
    }

    // --- Active train input ---
    const ts = trains[activeTrain];

    if (stickActive) {
      ts.cruiseLevel = 0; // stick overrides cruise
    } else {
      if (dpadUpEdge) {
        ts.cruiseLevel = clamp(ts.cruiseLevel + 1, -5, 5);
        log(`Train ${activeTrain + 1} cruise: ${ts.cruiseLevel}`);
      }
      if (dpadDownEdge) {
        ts.cruiseLevel = clamp(ts.cruiseLevel - 1, -5, 5);
        log(`Train ${activeTrain + 1} cruise: ${ts.cruiseLevel}`);
      }
    }

    // --- Physics for each train ---
    for (let i = 0; i < 2; i++) {
      const t = trains[i];

      let target;
      if (i === activeTrain && stickActive) {
        target = stickY * 100;
      } else {
        target = t.cruiseLevel * POWER_PER_LEVEL;
      }

      t.power = rampPower(t.power, target, dt);
      t.power = clamp(t.power, -100, 100);
      if (Math.abs(t.power) < 0.5 && target === 0) t.power = 0;

      // Send to motor (every 200ms to keep alive, or on change)
      const rounded = Math.round(t.power);
      const ls = lastSent[i];
      if (bleChars[i] && now - ls.time >= BLE_INTERVAL_MS) {
        if (rounded !== ls.power || rounded !== 0) {
          sendMotorPower(i, rounded);
          ls.power = rounded;
          ls.time = now;
        }
      }
    }

    updateLive();
  });
}

// --- Init ---
export function init() {
  startLoop();
  updateStatus();
  log("Ready. Connect trains and controller.");
}
