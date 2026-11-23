# deploy-brick-off on CCC over USB (owner-run, not recorded yet)

Deploy-and-run with the brick switched off while its program runs. `scripts/hardware-scenario.mts`
drives it and refuses to start without `--owner-present`; `recording.jsonl` goes into this
directory once the owner has run it and the recording passed the identifier search.

1. Find CCC on USB as in `usb-deploy-and-run-ccc`, `bricks/connect`, `files/exists` of
   `/home/root/lms2012/prjs/CockpitFixture` (false);
2. `programs/subscribe` CCC; `programs/deployAndRun` of `CockpitFixture/Wait.rbf` (the eight-second
   program of `usb-deploy-and-run-ccc`, inline);
3. **Instruction (a beep): "SWITCH THE BRICK OFF NOW (press its dark grey back button, then the
   centre button)."** The script waits up to 60 s for `bricks/changed` with CCC no longer
   connected;
4. `subscriptions/cancel` and `bricks/disconnect` (either may fail with the brick gone), then
   `daemon/exit`.

- **Brick state:** CCC on the USB cable, on the main menu, no `CockpitFixture` folder in the
  projects folder. After the run, switch the brick on again and remove the folder with the
  `remove-folder` scenario, recorded into a scratch directory.
- **Command:**

  ```
  node hardware-scenario.js deploy-brick-off --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb --owner-present
  ```
