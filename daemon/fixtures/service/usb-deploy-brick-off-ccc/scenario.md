# deploy-brick-off on CCC over USB (owner-run, recorded 23.11.2026)

Deploy-and-run with the battery pulled out of the brick while its program runs. `scripts/hardware-scenario.mts`
drives it and refuses to start without `--owner-present`; `recording.jsonl` goes into this
directory once the owner has run it and the recording passed the identifier search.

1. Find CCC on USB as in `usb-deploy-and-run-ccc`, `bricks/connect`, `files/exists` of
   `/home/root/lms2012/prjs/CockpitFixture` (false);
2. `programs/subscribe` CCC; `programs/deployAndRun` of `CockpitFixture/Wait.rbf` (the eight-second
   program of `usb-deploy-and-run-ccc`, inline);
3. **Instruction (a beep): "PULL THE BRICK'S BATTERY NOW (VYTÁHNI BATERII)."** The script waits up
   to 60 s for `bricks/changed` with CCC's USB channel no longer `connected` (`lost`, or gone
   from the list). The daemon keeps CCC signed in through the lost link, so `connected` alone
   would never change;
4. `subscriptions/cancel` and `bricks/disconnect` (either may fail with the brick gone), then
   `daemon/exit`.

- **Brick state:** CCC on the USB cable, on the main menu, no `CockpitFixture` folder in the
  projects folder. After the run, put the battery back, switch the brick on and remove the folder with the
  `remove-folder` scenario, recorded into a scratch directory.
- **Command:**

  ```
  node scripts/hardware-scenario.mts deploy-brick-off --daemon ./ev3-cockpitd --brick CCC --out ./out --transport usb --owner-present
  ```

**Recorded 23.11.2026 on HOSTA** (Windows, development build 0.3.1-preview.1): the program started
(runSeq 1), and the daemon reported CCC's USB channel no longer connected 4.0 s after the beep (the
person's reaction included). The identifier search found only the placeholder addresses.
