"""Open RFCOMM channel 1 to a brick, send one packet, read the reply; repeat right after closing.

usage: python3 -I rfcomm.py <MAC> <hex packet> <rounds> <pause seconds between rounds>
Prints one JSON line per round (no MAC in the output).
"""
import json
import socket
import sys
import time

mac, packet, rounds, pause = sys.argv[1], bytes.fromhex(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])

for r in range(rounds):
    out = {'round': r + 1}
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    s.settimeout(15)
    t0 = time.monotonic()
    try:
        s.connect((mac, 1))
        out['connect_ms'] = round((time.monotonic() - t0) * 1000)
        t1 = time.monotonic()
        s.send(packet)
        data = b''
        while len(data) < 2 or len(data) < 2 + int.from_bytes(data[:2], 'little'):
            chunk = s.recv(1024)
            if not chunk:
                break
            data += chunk
        out['reply_ms'] = round((time.monotonic() - t1) * 1000)
        out['reply_hex'] = data.hex()
    except OSError as e:
        out['error'] = f'{type(e).__name__}: errno={e.errno} {e.strerror or e}'
        out['after_ms'] = round((time.monotonic() - t0) * 1000)
    finally:
        t2 = time.monotonic()
        s.close()
        out['close_ms'] = round((time.monotonic() - t2) * 1000)
    print(json.dumps(out), flush=True)
    if r + 1 < rounds:
        time.sleep(pause)
