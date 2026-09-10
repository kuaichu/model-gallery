(() => {
  'use strict';
  const channel = 'prompt-gallery-camera-v1';
  let adapter, enabled = false, applying = false, pending = 0, baseRadius, baseTarget;
  const send = (type, extra = {}) => parent.postMessage({channel, type, ...extra}, '*');
  function snapshot() {
    const {camera, controls} = adapter;
    const offset = camera.position.clone().sub(controls.target);
    const radius = offset.length();
    return {theta: Math.atan2(offset.x, offset.z), phi: Math.acos(Math.max(-1, Math.min(1, offset.y / radius))), zoom: radius / baseRadius,
      pan: ['x','y','z'].map(axis => (controls.target[axis] - baseTarget[axis]) / baseRadius)};
  }
  function valid(value) {
    return value && [value.theta,value.phi,value.zoom].every(Number.isFinite) && value.zoom > 0 && value.zoom < 1e6 &&
      Array.isArray(value.pan) && value.pan.length === 3 && value.pan.every(v => Number.isFinite(v) && Math.abs(v) < 1e6);
  }
  function apply(value) {
    if (!valid(value)) return;
    cancelAnimationFrame(pending); pending = 0;
    applying = true;
    try {
      const {camera, controls} = adapter;
      adapter.cancelMotion?.();
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      const radius = Math.max(controls.minDistance || .001, Math.min(controls.maxDistance || Infinity, value.zoom * baseRadius));
      const phi = Math.max(controls.minPolarAngle || .001, Math.min(controls.maxPolarAngle || Math.PI, value.phi));
      const sin = Math.sin(phi);
      controls.target.set(...['x','y','z'].map((axis,i) => baseTarget[axis] + value.pan[i] * baseRadius));
      camera.position.set(radius * sin * Math.sin(value.theta), radius * Math.cos(phi), radius * sin * Math.cos(value.theta)).add(controls.target);
      controls.update();
      controls.enableDamping = damping;
    } finally { applying = false; }
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || !adapter) return;
    const message = event.data;
    if (message.type === 'configure') {
      enabled = !!message.enabled;
      adapter.controls.enableDamping = enabled ? false : adapter.originalDamping;
      if (enabled) adapter.cancelMotion?.();
      if (!enabled) { cancelAnimationFrame(pending); pending = 0; }
    }
    if (message.type === 'read') send('camera', {state: snapshot(), align: true});
    if (message.type === 'camera' && (enabled || message.align)) apply(message.state);
  });
  let attempts = 0;
  function discover() {
    const candidate = window.__galleryCamera || window.__voxelPalace;
    if (candidate?.camera?.position && candidate?.controls?.target) {
      adapter = candidate;
      const controls = adapter.controls;
      baseTarget = controls.target.clone();
      baseRadius = adapter.camera.position.distanceTo(baseTarget) || 1;
      adapter.originalDamping = controls.enableDamping;
      let autoRotate = controls.autoRotate;
      Object.defineProperty(controls, 'autoRotate', {configurable:true, get:() => enabled ? false : autoRotate, set:value => {autoRotate = value;}});
      controls.addEventListener('change', () => {
        if (!enabled || applying || pending) return;
        pending = requestAnimationFrame(() => { pending = 0; if (enabled) send('camera', {state:snapshot()}); });
      });
      send('ready');
    } else if (++attempts < 60) {
      setTimeout(discover, 200);
    } else send('unsupported');
  }
  discover();
})();
