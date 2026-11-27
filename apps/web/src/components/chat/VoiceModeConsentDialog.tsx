import { T, useGT } from "gt-react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Asked before the first start per destination. It names the environment, the endpoint and its address. */
export function VoiceModeConsentDialog(props: {
  readonly environmentLabel: string;
  readonly endpointLabel: string;
  readonly host: string;
  readonly allow: () => void;
  readonly cancel: () => void;
}) {
  const gt = useGT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.cancel();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {gt("Send microphone audio to {endpoint}?", { endpoint: props.endpointLabel })}
          </DialogTitle>
          <DialogDescription>
            {gt(
              "While voice mode is on, {environment} sends what your microphone hears to {endpoint} at {host}.",
              {
                environment: props.environmentLabel,
                endpoint: props.endpointLabel,
                host: props.host,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p>
            <T>
              The endpoint also receives the agent instructions of every project you use voice mode
              in, the titles of the threads you talk to, and what their coding agents reply and ask.
            </T>
          </p>
          <p className="text-sm text-muted-foreground">
            <T>This choice is saved on this device, and you can revoke it in Voice settings.</T>
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={props.cancel}>
            <T>Cancel</T>
          </Button>
          <Button type="button" size="sm" onClick={props.allow}>
            <T>Allow and start</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
