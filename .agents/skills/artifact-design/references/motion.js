/* Small, one-shot motion primitives. Inline this file into an Artifact; no imports. */
function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function beat(elements, { staggerMs = 70 } = {}) {
  const list = Array.from(elements)
  if (reducedMotion()) {
    for (const element of list) element.dataset.beat = 'done'
    return
  }
  for (const [index, element] of list.entries()) {
    element.classList.add('motion-enter')
    element.style.animationDelay = `${index * staggerMs}ms`
    element.addEventListener('animationend', () => { element.dataset.beat = 'done' }, { once: true })
  }
}

function highlight(element) {
  if (!element) return
  if (reducedMotion()) return
  element.classList.remove('motion-highlight')
  void element.offsetWidth
  element.classList.add('motion-highlight')
}

function tween({ from, to, duration = 420, update, done }) {
  if (reducedMotion()) {
    update(to)
    done?.()
    return () => {}
  }
  const start = performance.now()
  let frame = 0
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    update(from + (to - from) * eased)
    if (progress < 1) frame = requestAnimationFrame(step)
    else done?.()
  }
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}
