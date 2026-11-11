"""Pair one brick with bluetoothctl, answering the agent prompts; log every line with a timestamp.

usage: python3 -I pair.py <MAC> <logfile>
"""
import re
import sys
import time

import subprocess

import pexpect


def beep():
    sys.stdout.write('\a'); sys.stdout.flush()
    pass  # no audio output on HOSTC

mac, logpath = sys.argv[1], sys.argv[2]
t0 = time.monotonic()
log = open(logpath, 'w')


def note(s):
    log.write(f'{time.monotonic() - t0:7.2f} {s}\n')
    log.flush()


class Tee:
    def write(self, s):
        for line in re.sub(r'\x1b\[[0-9;]*[mK]|\r', '', s).splitlines():
            if line.strip():
                note('< ' + line)

    def flush(self):
        pass


bt = pexpect.spawn('bluetoothctl', encoding='utf-8', timeout=5)
bt.logfile_read = Tee()


def send(cmd):
    note('> ' + cmd)
    bt.sendline(cmd)


send('agent KeyboardDisplay')
send('default-agent')
send('menu scan')
send('transport bredr')
send('back')
send('scan on')
try:
    bt.expect(r'NEW\] Device ' + mac, timeout=40)
    note('# brick seen')
except pexpect.TIMEOUT:
    note('# brick not seen in 40 s')
send('scan off')
time.sleep(1)
note('# pair start')
beep()
send(f'pair {mac}')
prompts = [
    r'Confirm passkey (\d+)',
    r'Request confirmation',
    r'Enter PIN code',
    r'Enter passkey',
    r'Authorize service',
    r'Pairing successful',
    r'Failed to pair[^\n]*',
    r'not available',
]
deadline = time.monotonic() + 90
while time.monotonic() < deadline:
    try:
        i = bt.expect(prompts, timeout=10)
    except pexpect.TIMEOUT:
        beep()
        continue
    beep()
    if i in (0, 1, 4):
        send('yes')
    elif i in (2, 3):
        send('1234')
    else:
        note('# pairing ended: ' + bt.after)
        break
if time.monotonic() >= deadline:
    note('# pairing: no end within 90 s')
time.sleep(1)
send(f'info {mac}')
time.sleep(2)
send('quit')
bt.expect(pexpect.EOF, timeout=5)
