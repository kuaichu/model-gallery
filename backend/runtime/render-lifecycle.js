(() => {
  if (window.parent === window) return;
  const channel = 'prompt-gallery-render-v1';
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  const pausedAnimations = new Set();
  const pausedSVGs = new Set();
  let paused = false, sequence = 0;
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
      visualObserver.observe(document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:['class','style']});
    } else {
      visualObserver.disconnect();
      resumeVisualAnimations();
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
