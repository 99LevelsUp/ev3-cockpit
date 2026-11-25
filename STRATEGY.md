---
name: EVƎ Cockpit
last_updated: 2026-11-25
---

# EVƎ Cockpit Strategy

## Purpose

Students who have outgrown block-based programming have no good way to program an EV3 brick in text. EV3 Lab slows down on mid-sized projects, EV3 Classroom is limited (one brick at a time, missing commands), and ev3dev replaces the brick's firmware with a full Linux, which is heavy for the brick.

## Positioning

We program the brick in C, the language its own Linux already speaks, on the original firmware. The library is complete and consistent and the environment shows the brick's live state, so a student does not have to guess what works.

## Users

**Primary:** A student on a competition team who has mastered Classroom and wants more from the brick. They're hiring EVƎ Cockpit to do what Classroom does not allow (write logs to files, drive one brick from another) and to reach their own brick quickly in a room with dozens of computers and bricks.

## Boundaries

- Other languages (Python, blocks) are not planned. The project only must not close the door on them: the daemon stays neutral to the language.
- An overview of many students' bricks on one screen is not part of the cockpit. The cockpit provides data; a different client (an integration platform) would show several cockpits.
- No publication on the VS Code Marketplace until the product is complete.
- A textbook and other learning material come after the Marketplace release.

_Resist a change when:_ it serves someone other than a competition student who has outgrown block programming, or when it adds reach or library breadth before the cockpit can show what a program does.

## Key metrics

- **Competition result** - a student finishes the task in acceptable time with an acceptable result; measured at competitions.
- **Reaction speed** - a native C program reads sensors and reacts faster than the same program in Classroom's virtual machine; measured on a brick, same task in both.
- **Data back to the developer** - the logs and files a program writes come back to the computer complete; checked in the hardware acceptance run.
- **Time to a connected brick** - from sitting down to a connected brick in a room with many bricks; measured at competitions, only roughly on the bench.
- **Same behaviour as Classroom** - the brick's menu, start, stop and display behave as they do with a Classroom program; checked in the hardware acceptance run.

## Tracks

### Talking to the brick

The cockpit daemon, the `ev3` command and the other clients that find, connect and drive bricks over USB, Bluetooth and TCP, on Windows, Linux and macOS.

_Why it serves the approach:_ one daemon keeps a brick from being pulled at by two programs, and no student is limited by the computer they have.

### The cockpit environment

The VS Code panel and the brick Explorer: live state of bricks, ports and sensors, and the files a program writes.

_Why it serves the approach:_ it shows what a program does, so the library can be completed against real behaviour.

### Language and library (EVƎ C)

The C compiler, deploy and `ev3lib` in the add-on EVƎ C. Completed after the cockpit and its environment.

_Why it serves the approach:_ it is the C path itself, built so that a student does not meet gaps and inconsistencies.

## Milestones

- **2026-12-15** - Competition in Uničov. The cockpit is not expected to be ready.
- **2027-03-18** - Robotix competition at SPŠ Přerov.
- **2027-03-20** - Competition in Rybnik, Poland, open category: a demonstration of the cockpit.
