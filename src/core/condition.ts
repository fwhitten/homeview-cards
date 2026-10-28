import type { HomeAssistant } from './types';

/** A small state test, the same shape as HA's state / numeric_state conditions. */
export interface StateTest {
  entity?: string;
  attribute?: string;
  state?: string | number | Array<string | number>;
  state_not?: string | number | Array<string | number>;
  above?: number;
  below?: number;
}

const list = (v: unknown): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String));

/** True when every part of the test passes. `entity` defaults to the chip's own. */
export const passes = (hass: HomeAssistant, test: StateTest | undefined, fallbackEntity?: string): boolean => {
  if (!test) return false;
  const id = test.entity ?? fallbackEntity;
  const st = id ? hass.states[id] : undefined;
  if (!st) return false;
  const raw = test.attribute ? st.attributes[test.attribute] : st.state;
  const value = String(raw);
  if (test.state !== undefined && !list(test.state).includes(value)) return false;
  if (test.state_not !== undefined && list(test.state_not).includes(value)) return false;
  if (test.above !== undefined || test.below !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    if (test.above !== undefined && !(n > test.above)) return false;
    if (test.below !== undefined && !(n < test.below)) return false;
  }
  return true;
};

export const STATE_TEST_FIELDS = {
  state: { label: 'State is', selector: { text: {} } },
  state_not: { label: 'State is not', selector: { text: {} } },
  above: { label: 'Above', selector: { number: { mode: 'box' } } },
  below: { label: 'Below', selector: { number: { mode: 'box' } } },
};
