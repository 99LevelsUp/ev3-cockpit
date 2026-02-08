# EV3 Cockpit Architecture (Mermaid UML)

Tento dokument obsahuje UML diagramy pro `EV3 Cockpit` v Mermaid syntaxi.
Diagramy odpovidaji aktualnimu navrhu v `ev3-cockpit/DESIGN.md`.

## Obsah

1. Komponenty a hranice systemu
2. Domenovy model
3. Stavovy automat `BrickConnection`
4. Sekvence: TCP connect + capability probe
5. Sekvence: emergency preempce pri uploadu
6. Sekvence: timeout/cancel a orphan-risk recovery
7. Activity: Remote FS `safe`/`full` rezim

## 1) Komponenty a hranice systemu

```mermaid
classDiagram
direction LR

class VSCodeHost {
  <<runtime>>
}

class BrickPanel {
  <<webview>>
}

class BrickTreeProvider {
  <<explorer-view>>
}

class ConnectionManager {
  <<component>>
  +addBrick()
  +removeBrick()
  +setActiveBrick()
}

class BrickConnection {
  <<component>>
  +connect()
  +disconnect()
  +execute(request)
}

class CommandScheduler {
  <<component>>
  +enqueue(lane, request)
  +cancel(token)
  +resync()
}

class DeviceProvider {
  <<component>>
  +readSensors()
  +controlMotors()
  +uiOps()
}

class RemoteFsProvider {
  <<component>>
  +readDirectory()
  +readFile()
  +writeFile()
  +delete()
}

class CapabilityProbe {
  <<component>>
  +detectFirmware()
  +buildProfile()
}

class Diagnostics {
  <<component>>
  +log()
  +traceHex()
}

class TransportAdapter {
  <<interface>>
  +open()
  +close()
  +write(bytes)
  +read()
}

class UsbHidAdapter {
  <<transport>>
}

class BtRfcommAdapter {
  <<transport>>
}

class TcpAdapter {
  <<transport>>
}

class EV3Brick {
  <<external-system>>
}

VSCodeHost --> ConnectionManager
VSCodeHost --> BrickTreeProvider
VSCodeHost --> BrickPanel

ConnectionManager "1" o-- "*" BrickConnection : manages
BrickConnection --> CommandScheduler
BrickConnection --> DeviceProvider
BrickConnection --> RemoteFsProvider
BrickConnection --> CapabilityProbe
BrickConnection --> Diagnostics
BrickConnection --> TransportAdapter

TransportAdapter <|.. UsbHidAdapter
TransportAdapter <|.. BtRfcommAdapter
TransportAdapter <|.. TcpAdapter
UsbHidAdapter --> EV3Brick
BtRfcommAdapter --> EV3Brick
TcpAdapter --> EV3Brick

BrickTreeProvider --> RemoteFsProvider
BrickPanel --> DeviceProvider
RemoteFsProvider --> CommandScheduler
DeviceProvider --> CommandScheduler
CommandScheduler --> TransportAdapter : serialized I/O
```

## 2) Domenovy model

```mermaid
classDiagram
direction TB

class BrickIdentity {
  +brickId: UUID
  +name: string
  +serialNumber: string
  +transport: TransportType
  +address: string
  +role: BrickRole
  +layer: int
}

class BrickRuntime {
  +state: BrickState
  +active: bool
  +lastSeenAt: datetime
}

class CapabilityProfile {
  +name: string
  +supportsContinueList: bool
  +minPollingUsbMs: int
  +minPollingBtTcpMs: int
  +timeouts: map
}

class CommandRequest {
  +id: string
  +messageCounter: uint16
  +lane: Lane
  +timeoutMs: int
  +idempotent: bool
}

class PendingRequest {
  +requestId: string
  +sentAt: datetime
  +cancellable: bool
}

class BrickState {
  <<enumeration>>
  NEW
  CONNECTING
  READY
  UNAVAILABLE
  RECONNECTING
  ERROR
  REMOVED
}

class Lane {
  <<enumeration>>
  emergency
  high
  normal
  low
}

class FsMode {
  <<enumeration>>
  safe
  full
}

BrickIdentity "1" *-- "1" BrickRuntime
BrickRuntime "1" o-- "1" CapabilityProfile
CommandRequest "1" --> "0..1" PendingRequest
BrickRuntime --> BrickState
CommandRequest --> Lane
```

## 3) Stavovy automat `BrickConnection`

```mermaid
stateDiagram-v2
[*] --> NEW
NEW --> CONNECTING: connect()
CONNECTING --> READY: handshake + capability probe OK
CONNECTING --> ERROR: fatal connect/handshake error

READY --> UNAVAILABLE: transport drop
UNAVAILABLE --> RECONNECTING: auto-reconnect
RECONNECTING --> READY: reconnected + resync
RECONNECTING --> ERROR: retry exhausted

READY --> UNAVAILABLE: timeout/cancel -> orphan-risk
UNAVAILABLE --> RECONNECTING: recover transport

READY --> REMOVED: user remove
UNAVAILABLE --> REMOVED: user remove
ERROR --> REMOVED: user remove

REMOVED --> [*]
```

## 4) Sekvence: TCP connect + capability probe

```mermaid
sequenceDiagram
autonumber
actor U as User
participant UI as VS Code UI
participant CM as ConnectionManager
participant BC as BrickConnection
participant TA as TcpAdapter
participant EV3 as EV3 Brick
participant CP as CapabilityProbe
participant CS as CommandScheduler

U->>UI: Connect (TCP/IP)
UI->>CM: connectBrick(address)
CM->>BC: create + connect()
BC->>TA: open()
TA->>EV3: UDP discovery/ack (3015)
TA->>EV3: TCP connect (5555)
TA->>EV3: GET /target?sn=... VMTP1.0
EV3-->>TA: Accept: EV340 (or compatible)
TA-->>BC: transport ready

BC->>CP: detectFirmware()
CP->>CS: enqueue probe requests
CS->>EV3: info/system/direct probes
EV3-->>CS: replies
CS-->>CP: probe results
CP-->>BC: CapabilityProfile
BC-->>CM: READY
CM-->>UI: brick online
```

## 5) Sekvence: emergency preempce pri uploadu

```mermaid
sequenceDiagram
autonumber
actor U as User
participant UI as VS Code UI
participant FS as RemoteFsProvider
participant CS as CommandScheduler
participant TA as TransportAdapter
participant EV3 as EV3 Brick

U->>UI: Upload file
UI->>FS: writeFile()
FS->>CS: enqueue(low, BEGIN_DOWNLOAD + chunks)

loop file transfer
  CS->>TA: send chunk(1000B)
  TA->>EV3: CONTINUE_DOWNLOAD
  EV3-->>TA: SYSTEM_REPLY
end

U->>UI: Emergency Stop
UI->>CS: enqueue(emergency, STOP_ALL)
CS->>CS: preempt at chunk boundary
CS->>TA: send STOP_ALL now
TA->>EV3: DIRECT_COMMAND_REPLY
EV3-->>TA: DIRECT_REPLY
CS-->>UI: emergency completed

opt upload still pending
  CS-->>FS: mark interrupted/cancelled
end
```

## 6) Sekvence: timeout/cancel a orphan-risk recovery

```mermaid
sequenceDiagram
autonumber
participant FS as RemoteFsProvider
participant CS as CommandScheduler
participant TA as TransportAdapter
participant EV3 as EV3 Brick

FS->>CS: enqueue(normal, LIST/UPLOAD op)
CS->>TA: send request
TA->>EV3: request
Note over CS: timeout reached or user cancel
CS->>CS: set state = orphan-risk
CS->>TA: stop accepting new writes

alt drain possible
  TA-->>CS: late/orphan replies drained
  CS->>CS: parser consistent
else drain not possible
  CS->>TA: close()
  CS->>TA: reopen()
end

CS->>CS: resync counters + clear pending lower lanes
CS-->>FS: operation failed (recoverable)
```

## 7) Activity: Remote FS `safe`/`full` rezim

```mermaid
stateDiagram-v2
[*] --> ValidatePath
ValidatePath --> Reject: canonicalization fail
ValidatePath --> SafeMode: fs.mode = safe
ValidatePath --> FullMode: fs.mode = full

SafeMode --> CheckSafeRoots
CheckSafeRoots --> Reject: outside allowed roots
CheckSafeRoots --> Reject: blocked system path
CheckSafeRoots --> ExecuteOp

FullMode --> ConfirmRisk
ConfirmRisk --> Reject: user denied
ConfirmRisk --> CheckHardBlock
CheckHardBlock --> Reject: /proc or /sys or /dev
CheckHardBlock --> ExecuteOp

ExecuteOp --> [*]
Reject --> [*]
```
