<#
.SYNOPSIS
  Which presence check reaches a brick without raising its pairing dialog? (step-4 U10, path a)

.DESCRIPTION
  On a pairing broken on the brick's side (Windows paired, the brick no longer lists this
  computer), the cockpit's presence check - an uncached RFCOMM service query through WinRT -
  raised the brick's pairing dialog (11.11.2026, 1 of 2 queries). The firmware shows the dialog
  on EVT_PIN_CODE_REQ: an incoming link that asks to authenticate with a key the brick no longer
  has (c_bt.c 2947, 3243). A Winsock RFCOMM connect to the same brick raised none (09.11.2026).
  So the question is whether the API, not the radio contact, decides.

  Runs rounds of three candidates against one brick, one trial every -GapSeconds, each preceded
  by a beep. The person at the brick notes after which beep a dialog came, and cancels it.

    C1  WinRT BluetoothDevice.GetRfcommServicesAsync(Uncached) - the shipped check (helper --sdp)
    C2  Winsock SDP query: WSALookupServiceBegin(NS_BTH, SerialPort UUID, LUP_FLUSHCACHE)
    C3  Winsock RFCOMM connect to the SerialPort service, authentication not requested

  Read only towards the brick except C3, which opens and at once closes an RFCOMM link. Run it
  only while the cockpit is closed: it would check and join the same brick.

.EXAMPLE
  & scripts/presence-auth-probe.ps1 -Mac 00:16:53:F0:0B:0B -Rounds 3
#>
param(
    [Parameter(Mandatory)] [string] $Mac,
    [int] $Rounds = 3,
    [int] $GapSeconds = 25,
    [string[]] $Methods = @('C1', 'C2', 'C3'),
    [switch] $NoBeep
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $repo 'native\bin\bt-pairing-helper.exe'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class BtPresenceProbe
{
    const int AF_BTH = 32, SOCK_STREAM = 1, BTHPROTO_RFCOMM = 3, NS_BTH = 16;
    const int LUP_FLUSHCACHE = 0x1000, LUP_RETURN_ALL = 0x0FF0;
    static readonly Guid SerialPort = new Guid("00001101-0000-1000-8000-00805F9B34FB");

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct SOCKADDR_BTH { public ushort addressFamily; public ulong btAddr; public Guid serviceClassId; public uint port; }

    [StructLayout(LayoutKind.Sequential)]
    struct WSAQUERYSETW
    {
        public int dwSize; public IntPtr lpszServiceInstanceName; public IntPtr lpServiceClassId; public IntPtr lpVersion;
        public IntPtr lpszComment; public int dwNameSpace; public IntPtr lpNSProviderId; public IntPtr lpszContext;
        public int dwNumberOfProtocols; public IntPtr lpafpProtocols; public IntPtr lpszQueryString;
        public int dwNumberOfCsAddrs; public IntPtr lpcsaBuffer; public int dwOutputFlags; public IntPtr lpBlob;
    }

    [DllImport("ws2_32.dll")] static extern int WSAStartup(ushort version, byte[] data);
    [DllImport("ws2_32.dll", SetLastError = true)] static extern IntPtr socket(int af, int type, int protocol);
    [DllImport("ws2_32.dll", SetLastError = true)] static extern int connect(IntPtr s, ref SOCKADDR_BTH name, int namelen);
    [DllImport("ws2_32.dll")] static extern int closesocket(IntPtr s);
    [DllImport("ws2_32.dll")] static extern int WSAGetLastError();
    [DllImport("ws2_32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int WSALookupServiceBeginW(ref WSAQUERYSETW restrictions, int flags, out IntPtr lookup);
    [DllImport("ws2_32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int WSALookupServiceNextW(IntPtr lookup, int flags, ref int bufferLength, IntPtr results);
    [DllImport("ws2_32.dll")] static extern int WSALookupServiceEnd(IntPtr lookup);

    static BtPresenceProbe() { WSAStartup(0x0202, new byte[512]); }

    static ulong Address(string mac) { return Convert.ToUInt64(mac.Replace(":", "").Replace("-", ""), 16); }

    /// <summary>C2: an SDP service search through Winsock, bypassing the cache.</summary>
    public static string WinsockSdp(string mac)
    {
        IntPtr guid = Marshal.AllocHGlobal(16);
        IntPtr context = Marshal.StringToHGlobalUni("(" + mac + ")");
        IntPtr results = Marshal.AllocHGlobal(4096);
        try
        {
            Marshal.Copy(SerialPort.ToByteArray(), 0, guid, 16);
            var q = new WSAQUERYSETW();
            q.dwSize = Marshal.SizeOf(typeof(WSAQUERYSETW));
            q.lpServiceClassId = guid;
            q.dwNameSpace = NS_BTH;
            q.lpszContext = context;
            IntPtr lookup;
            if (WSALookupServiceBeginW(ref q, LUP_FLUSHCACHE, out lookup) != 0)
            {
                return "begin failed, WSA " + WSAGetLastError();
            }
            try
            {
                int found = 0;
                while (true)
                {
                    int length = 4096;
                    if (WSALookupServiceNextW(lookup, LUP_RETURN_ALL, ref length, results) != 0)
                    {
                        int error = WSAGetLastError();
                        return found > 0 ? "answered, " + found + " record(s)" : "no record, WSA " + error;
                    }
                    found++;
                }
            }
            finally { WSALookupServiceEnd(lookup); }
        }
        finally
        {
            Marshal.FreeHGlobal(guid); Marshal.FreeHGlobal(context); Marshal.FreeHGlobal(results);
        }
    }

    /// <summary>C3: an RFCOMM connect to the SerialPort service, closed at once; 15 s at most.</summary>
    public static string WinsockConnect(string mac)
    {
        IntPtr s = socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM);
        if (s == new IntPtr(-1)) { return "socket failed, WSA " + WSAGetLastError(); }
        var address = new SOCKADDR_BTH { addressFamily = AF_BTH, btAddr = Address(mac), serviceClassId = SerialPort, port = 0 };
        var attempt = Task.Run(() => { int rc = connect(s, ref address, Marshal.SizeOf(typeof(SOCKADDR_BTH))); return rc == 0 ? 0 : WSAGetLastError(); });
        if (!attempt.Wait(15000))
        {
            closesocket(s);
            return "no answer in 15 s";
        }
        closesocket(s);
        return attempt.Result == 0 ? "connected" : "failed, WSA " + attempt.Result;
    }
}
'@

function Invoke-Trial([string] $method) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $result = switch ($method) {
        'C1' {
            $out = & $helper --sdp --mac $Mac --timeout-seconds 10 2>&1 | Out-String
            ($out.Trim() -split "`n" | Select-Object -Last 1)
        }
        'C2' { [BtPresenceProbe]::WinsockSdp($Mac) }
        'C3' { [BtPresenceProbe]::WinsockConnect($Mac) }
    }
    "{0:N1} s  {1}" -f $sw.Elapsed.TotalSeconds, $result
}

$trial = 0
for ($round = 1; $round -le $Rounds; $round++) {
    foreach ($method in $Methods) {
        $trial++
        if (-not $NoBeep) { [console]::beep(1000, 400) }
        $at = Get-Date -Format 'HH:mm:ss'
        $line = Invoke-Trial $method
        "#{0,-2} {1}  {2}  {3}" -f $trial, $at, $method, $line
        Start-Sleep -Seconds $GapSeconds
    }
}
