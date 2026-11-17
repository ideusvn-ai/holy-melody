// CHỈ dùng cho bản preview offline (không có npm). Bản thật dùng gói zustand.
import { useSyncExternalStore } from 'react';
export function create(init) {
  let state;
  const listeners = new Set();
  const setState = (partial, replace) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    if (Object.is(next, state)) return;
    const prev = state;
    state = replace ? next : Object.assign({}, state, next);
    listeners.forEach((l) => l(state, prev));
  };
  const getState = () => state;
  const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
  const api = { setState, getState, subscribe };
  state = init(setState, getState, api);
  const useBound = (selector = (s) => s) => useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
  Object.assign(useBound, api);
  return useBound;
}
