// ============================================================
// SaveSync Landing Page Interactive Orchestrator
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initSimulator();
  initScrollAnimations();
});

// ============================================================
// DYNAMIC P2P SYNC SIMULATOR
// ============================================================
function initSimulator() {
  const btnModify = document.getElementById('btn-trigger-modify');
  const signal = document.getElementById('ping-signal');
  const speedBubble = document.getElementById('sim-speed-bubble');
  const progressBlock = document.getElementById('sim-progress-block');
  const progressFill = document.getElementById('sim-progress-fill');
  const progressPercent = document.getElementById('sim-progress-percent');
  const progressStatus = document.getElementById('sim-progress-status');
  const consoleLogs = document.getElementById('sim-console-logs');

  const fileAData = document.querySelector('#device-a-files li[data-file="data.bin"]');
  const fileBData = document.querySelector('#device-b-files li[data-file="data.bin"]');

  if (!btnModify) return;

  btnModify.addEventListener('click', async () => {
    btnModify.disabled = true;
    btnModify.textContent = 'Syncing...';

    // 1. Log modification event
    addLogLine('event', 'Local save file edit detected: data.bin');
    fileAData.classList.add('modified');

    await sleep(800);
    addLogLine('info', 'Calculating delta blocks using rolling checksums...');

    await sleep(600);
    addLogLine('info', 'Found 1 modified block (1.5 MB difference out of 12.0 MB total)');

    // 2. Launch sync connection signal
    await sleep(400);
    addLogLine('event', 'Initiating connection to paired peer "Gaming PC"...');
    signal.style.display = 'block';
    signal.style.animation = 'pingRight 2s linear infinite';
    speedBubble.classList.add('active');
    speedBubble.textContent = 'Connecting...';

    await sleep(1000);
    addLogLine('success', 'Connection established. Exchanging file manifests.');

    // 3. Start block replication progress
    await sleep(600);
    progressBlock.classList.remove('hidden');
    addLogLine('info', 'Remote peer syncing delta blocks...');

    let percent = 0;
    const totalBytes = 1.5 * 1024 * 1024; // 1.5MB delta
    const interval = setInterval(() => {
      percent += 5;
      if (percent > 100) percent = 100;

      // Update progress graphics
      progressFill.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;

      // Fluctuate transfer speed
      const speed = (5.2 + Math.sin(percent / 10) * 1.4).toFixed(1);
      speedBubble.textContent = `${speed} MB/s`;

      const bytesTransferred = ((totalBytes * percent) / 100 / 1024 / 1024).toFixed(2);
      const progressDetails = document.getElementById('sim-progress-details');
      if (progressDetails) {
        progressDetails.textContent = `${bytesTransferred} MB / 1.50 MB`;
      } else {
        progressStatus.textContent = `Pulling: ${bytesTransferred} MB / 1.50 MB`;
      }

      if (percent === 100) {
        clearInterval(interval);
        completeSync();
      }
    }, 150);

    async function completeSync() {
      // 4. Wrap up sync operations
      addLogLine('success', 'Delta blocks successfully patched locally on "Gaming PC"!');
      fileBData.classList.add('modified');
      fileBData.querySelector('.file-size').textContent = '12 MB';

      await sleep(600);
      addLogLine('success', 'Sync Complete! Both devices are synchronized.');
      signal.style.display = 'none';
      signal.style.animation = 'none';
      speedBubble.classList.remove('active');
      speedBubble.textContent = 'Synced';

      await sleep(1000);
      progressBlock.classList.add('hidden');
      progressFill.style.width = '0%';
      progressPercent.textContent = '0%';
      fileAData.classList.remove('modified');
      fileBData.classList.remove('modified');

      btnModify.disabled = false;
      btnModify.textContent = 'Modify Save File';
    }
  });

  // Helper to output styled lines inside virtual log box
  function addLogLine(type, text) {
    const line = document.createElement('div');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    line.className = `log-line ${type}`;
    line.textContent = `[${time}] [${type.toUpperCase()}] ${text}`;

    consoleLogs.appendChild(line);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;

    // Prune excessive log histories
    while (consoleLogs.childElementCount > 15) {
      consoleLogs.removeChild(consoleLogs.firstChild);
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================
// SCROLL TRIGGERS & FADE-IN ANIMATIONS
// ============================================================
function initScrollAnimations() {
  const cards = document.querySelectorAll('.feature-card, .step-card, .bottom-download-box');
  
  // Set up animation observers
  const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  };

  const observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('animate-fade-in');
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  cards.forEach(card => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(20px)';
    card.style.transition = 'opacity 0.6s ease-out, transform 0.6s ease-out';
    observer.observe(card);
  });

  // Dynamic CSS injector for observer animations
  const style = document.createElement('style');
  style.innerHTML = `
    .animate-fade-in {
      opacity: 1 !important;
      transform: translateY(0) !important;
    }
  `;
  document.head.appendChild(style);
}
