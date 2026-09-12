(() => {
  if (window.parent === window) return;
  const channel = 'prompt-gallery-render-v1';
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const timers = new Map();
  let timerSequence = 0;
  const pausedAnimations = new Set();
  const pausedSVGs = new Set();
  let paused = false, sequence = 0;

  function delayValue(value) {
    const delay = Number(value);
    return Number.isFinite(delay) ? Math.max(0, delay) : 0;
  }
  function armTimeout(token, timer) {
    timer.startedAt = performance.now();
    timer.dueAt = timer.startedAt + timer.remaining;
    timer.nativeId = nativeSetTimeout(() => {
      timer.nativeId = null;
      timers.delete(token);
      if (!paused) timer.callback(...timer.args);
    }, timer.remaining);
  }
  function armInterval(timer) {
    timer.nativeId = nativeSetInterval(() => {
      if (!paused) timer.callback(...timer.args);
    }, timer.delay);
  }
  function pauseTimers() {
    const now = performance.now();
    for (const timer of timers.values()) {
      if (timer.nativeId == null) continue;
      if (timer.kind === 'timeout') {
        timer.remaining = Math.max(0, timer.dueAt - now);
        nativeClearTimeout(timer.nativeId);
      } else nativeClearInterval(timer.nativeId);
      timer.nativeId = null;
    }
  }
  function resumeTimers() {
    for (const [token, timer] of timers) {
      if (timer.nativeId != null) continue;
      if (timer.kind === 'timeout') armTimeout(token, timer);
      else armInterval(timer);
    }
  }
  window.setTimeout = (callback, delay, ...args) => {
    if (typeof callback !== 'function') return nativeSetTimeout(callback, delay, ...args);
    const token = ++timerSequence;
    const timer = {kind:'timeout', callback, args, remaining:delayValue(delay), nativeId:null, dueAt:0};
    timers.set(token, timer);
    if (!paused) armTimeout(token, timer);
    return token;
  };
  window.clearTimeout = token => {
    const timer = timers.get(token);
    if (!timer) return nativeClearTimeout(token);
    if (timer.nativeId != null) (timer.kind === 'interval' ? nativeClearInterval : nativeClearTimeout)(timer.nativeId);
    timers.delete(token);
  };
  window.setInterval = (callback, delay, ...args) => {
    if (typeof callback !== 'function') return nativeSetInterval(callback, delay, ...args);
    const token = ++timerSequence;
    const timer = {kind:'interval', callback, args, delay:delayValue(delay), nativeId:null};
    timers.set(token, timer);
    if (!paused) armInterval(timer);
    return token;
  };
  window.clearInterval = token => {
    const timer = timers.get(token);
    if (!timer) return nativeClearInterval(token);
    if (timer.nativeId != null) (timer.kind === 'timeout' ? nativeClearTimeout : nativeClearInterval)(timer.nativeId);
    timers.delete(token);
  };
  function pauseVisualAnimations() {
    if (!paused) return;
    for (const animation of document.getAnimations?.() || []) {
      if (animation.playState === 'running') {
        animation.pause();
        pausedAnimations.add(animation);
      }
    }
    for (const svg of document.querySelectorAll('svg')) {
      if (typeof svg.pauseAnimations === 'function' && !svg.animationsPaused()) {
        svg.pauseAnimations();
        pausedSVGs.add(svg);
      }
    }
  }
  function resumeVisualAnimations() {
    for (const animation of pausedAnimations) {
      if (animation.playState === 'paused') animation.play();
    }
    pausedAnimations.clear();
    for (const svg of pausedSVGs) {
      if (svg.isConnected && svg.animationsPaused()) svg.unpauseAnimations();
    }
    pausedSVGs.clear();
  }
  const visualObserver = new MutationObserver(pauseVisualAnimations);
  addEventListener('load', pauseVisualAnimations);
  document.addEventListener('animationstart', pauseVisualAnimations, true);
  function schedule(id, item) {
    item.nativeId = request(time => {
      item.nativeId = null;
      if (paused) return;
      pending.delete(id);
      item.callback(time);
    });
  }
  window.requestAnimationFrame = callback => {
    const id = ++sequence, item = {callback, nativeId:null};
    pending.set(id, item);
    if (!paused) schedule(id, item);
    return id;
  };
  window.cancelAnimationFrame = id => {
    const item = pending.get(id);
    if (item?.nativeId != null) cancel(item.nativeId);
    pending.delete(id);
  };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data.type !== 'configure') return;
    const next = event.data.paused === true;
    if (next === paused) return;
    paused = next;
    if (paused) {
      pauseVisualAnimations();
      pauseTimers();
      visualObserver.observe(document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:['class','style']});
    } else {
      visualObserver.disconnect();
      resumeVisualAnimations();
      resumeTimers();
    }
    for (const [id, item] of pending) {
      if (paused) {
        if (item.nativeId != null) cancel(item.nativeId);
        item.nativeId = null;
      } else schedule(id, item);
    }
  });
  parent.postMessage({channel,type:'ready'}, '*');
  addEventListener('load', () => parent.postMessage({channel,type:'loaded'}, '*'), {once:true});
})();
