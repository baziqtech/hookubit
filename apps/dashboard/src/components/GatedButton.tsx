import { deniedReason, mayAct, type RoleGate } from '../lib/role-gate';
import { Button, type ButtonProps } from './Button';

export interface GatedButtonProps extends ButtonProps {
  gate: RoleGate;
  /** Gerund phrase for the denial tooltip: "Creating a subscription". */
  action: string;
}

/**
 * A write control behind a role gate — disabled WITH A REASON rather than
 * missing, the shape `RequeueButton` in the outbox established.
 *
 * A button that vanishes for a viewer reads as a broken page; a button that
 * fails with a 403 every time reads as a broken product. One that is greyed
 * out and says "needs the admin or owner role — you are a viewer" is the only
 * one of the three the person can act on (by asking).
 */
export function GatedButton({ gate, action, disabled, title, ...props }: GatedButtonProps) {
  const allowed = mayAct(gate);
  return (
    <Button
      {...props}
      disabled={disabled || !allowed}
      title={allowed ? title : deniedReason(gate, action)}
      aria-disabled={!allowed || undefined}
    />
  );
}
