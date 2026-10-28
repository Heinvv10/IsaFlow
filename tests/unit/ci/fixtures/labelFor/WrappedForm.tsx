import { forwardRef, memo } from 'react';
import { Component } from 'react';

export const Memoed = memo(() => <><label>Memo field</label><input /></>);

export const Forwarded = forwardRef(function (_props, ref) {
  return <><label>Forward field</label><input ref={ref} /></>;
});

export class Classy extends Component {
  render() {
    return <><label>Class field</label><input /></>;
  }
}

export default () => <><label>Anonymous field</label><input /></>;

export function Plain() {
  return <><label>Plain field</label><input /></>;
}
