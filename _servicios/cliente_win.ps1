# Control del cliente Windows (R2.exe) para hacer comparaciones automaticas
# contra el cliente web.
#
# El cliente es VB6 + DirectDraw. PrintWindow devuelve negro sobre superficies
# DirectDraw, asi que la captura se hace copiando del ESCRITORIO sobre el
# rectangulo de la ventana: para eso hay que traerla al frente primero.
#
# Las teclas van por SendInput con SCANCODE. Con mensajes de ventana
# (PostMessage WM_KEYDOWN) el juego no se entera, porque lee el teclado por
# DirectInput/GetAsyncKeyState, no por la cola de mensajes.
#
# Uso:
#   .\cliente_win.ps1 info
#   .\cliente_win.ps1 captura C:\ruta\foto.png
#   .\cliente_win.ps1 tecla Down 350
#   .\cliente_win.ps1 tecla Down 350 -Luego C:\ruta\foto.png
param(
  [Parameter(Mandatory=$true)][string]$Accion,
  [string]$Arg1,
  [string]$Arg2,
  [string]$Luego
)

Add-Type -AssemblyName System.Drawing

if (-not ("Win32Dbo" -as [type])) {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Dbo {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);

  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  // OJO con el tamano: en x64 la union interna la marca MOUSEINPUT, que es mas
  // grande que KEYBDINPUT, y el struct completo mide 40 bytes. Si se declara
  // solo con KEYBDINPUT queda en 32 y `SendInput` rechaza la llamada en
  // silencio (devuelve 0 y no pasa nada). El relleno lo lleva a 40.
  [StructLayout(LayoutKind.Explicit)] public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT ki;      // la union empieza en 8 en x64
    [FieldOffset(32)] public long relleno;
  }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);

  const uint KEYEVENTF_KEYUP     = 0x0002;
  const uint KEYEVENTF_SCANCODE  = 0x0008;
  const uint KEYEVENTF_EXTENDED  = 0x0001;

  // Las flechas son teclas "extendidas": sin ese flag el juego las confunde
  // con las del teclado numerico.
  static bool EsExtendida(ushort vk) {
    return vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 ||
           vk == 0x2D || vk == 0x2E || vk == 0x24 || vk == 0x23 ||
           vk == 0x21 || vk == 0x22;
  }

  public static int TamInput() { return Marshal.SizeOf(typeof(INPUT)); }
  public static uint UltimoEnvio = 0;

  static void Manda(ushort vk, bool soltar) {
    ushort sc = (ushort)MapVirtualKey(vk, 0);
    uint f = KEYEVENTF_SCANCODE;
    if (EsExtendida(vk)) f |= KEYEVENTF_EXTENDED;
    if (soltar) f |= KEYEVENTF_KEYUP;
    INPUT[] i = new INPUT[1];
    i[0].type = 1;
    i[0].ki.wVk = 0;
    i[0].ki.wScan = sc;
    i[0].ki.dwFlags = f;
    i[0].ki.dwExtraInfo = IntPtr.Zero;
    UltimoEnvio = SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Pulsa(ushort vk)  { Manda(vk, false); }
  public static void Suelta(ushort vk) { Manda(vk, true); }

  // Raton. Hace falta para dar el foco al lienzo del juego: si el foco esta en
  // una caja de texto (el chat, el "Perfil del Viajero"), las flechas se las
  // come el cuadro y el personaje no se mueve.
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  public static void Clic(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);   // LEFTDOWN
    System.Threading.Thread.Sleep(40);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);   // LEFTUP
  }
}
"@
}

$VK = @{
  'Up'=0x26; 'Down'=0x28; 'Left'=0x25; 'Right'=0x27;
  'Enter'=0x0D; 'Escape'=0x1B; 'Space'=0x20; 'Shift'=0x10; 'Ctrl'=0x11;
  'Insert'=0x2D; 'End'=0x23; 'F6'=0x75; 'F7'=0x76; 'F8'=0x77
}

# OJO: `MainWindowHandle` de un VB6 apunta al formulario oculto `ThunderRT6Main`,
# que mide 0x0. La ventana que se ve es otra, de clase `ThunderRT6FormDC`. Hay
# que enumerarlas todas y quedarse con la visible que tenga tamano.
function Get-Ventana {
  $p = Get-Process -Name 'R2' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { throw "El cliente no esta abierto (no encuentro el proceso R2)." }
  $objetivo = $p.Id
  $encontradas = New-Object System.Collections.ArrayList
  $cb = [Win32Dbo+Proc]{
    param($h, $l)
    $suPid = 0
    [void][Win32Dbo]::GetWindowThreadProcessId($h, [ref]$suPid)
    if ($suPid -eq $objetivo -and [Win32Dbo]::IsWindowVisible($h)) {
      $c = New-Object System.Text.StringBuilder 256
      [void][Win32Dbo]::GetClassName($h, $c, 256)
      $r = New-Object Win32Dbo+RECT
      [void][Win32Dbo]::GetWindowRect($h, [ref]$r)
      if ($c.ToString() -eq 'ThunderRT6FormDC' -and ($r.R - $r.L) -gt 100) {
        [void]$encontradas.Add($h)
      }
    }
    return $true
  }
  [void][Win32Dbo]::EnumWindows($cb, [IntPtr]::Zero)
  if ($encontradas.Count -eq 0) { throw "El proceso R2 esta, pero no encuentro su ventana visible." }
  return [pscustomobject]@{ Id = $p.Id; MainWindowHandle = $encontradas[0]; MainWindowTitle = 'Dream Blue Online' }
}

function Frente($h) {
  if ([Win32Dbo]::IsIconic($h)) { [void][Win32Dbo]::ShowWindow($h, 9) }   # SW_RESTORE
  [void][Win32Dbo]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 250
}

function Captura($h, $ruta) {
  $r = New-Object Win32Dbo+RECT
  [void][Win32Dbo]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -le 0 -or $hh -le 0) { throw "Rectangulo de ventana invalido ($w x $hh)." }
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $g.Dispose()
  $dir = Split-Path $ruta -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $bmp.Save($ruta, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return "$ruta ($w x $hh)"
}

$proc = Get-Ventana
$hwnd = $proc.MainWindowHandle

switch ($Accion.ToLower()) {
  'info' {
    $r = New-Object Win32Dbo+RECT
    [void][Win32Dbo]::GetWindowRect($hwnd, [ref]$r)
    "PID $($proc.Id)  titulo '$($proc.MainWindowTitle)'  hwnd $hwnd"
    "rect L=$($r.L) T=$($r.T) R=$($r.R) B=$($r.B)  ->  $($r.R-$r.L) x $($r.B-$r.T)"
    "al frente: $([Win32Dbo]::GetForegroundWindow() -eq $hwnd)"
  }
  'captura' {
    Frente $hwnd
    Captura $hwnd $Arg1
  }
  'clic' {
    # Coordenadas RELATIVAS a la ventana, para no depender de donde este.
    $r = New-Object Win32Dbo+RECT
    [void][Win32Dbo]::GetWindowRect($hwnd, [ref]$r)
    Frente $hwnd
    $x = $r.L + [int]$Arg1
    $y = $r.T + [int]$Arg2
    [Win32Dbo]::Clic($x, $y)
    Start-Sleep -Milliseconds 200
    "clic en ventana ($Arg1,$Arg2) -> pantalla ($x,$y)"
    if ($Luego) { Captura $hwnd $Luego }
  }
  'tecla' {
    if (-not $VK.ContainsKey($Arg1)) { throw "Tecla desconocida '$Arg1'. Validas: $($VK.Keys -join ', ')" }
    $ms = 300; if ($Arg2) { $ms = [int]$Arg2 }
    Frente $hwnd
    # PowerShell no conoce [ushort]: el tipo se llama [uint16].
    $vk = [uint16]$VK[$Arg1]
    [Win32Dbo]::Pulsa($vk)
    Start-Sleep -Milliseconds $ms
    [Win32Dbo]::Suelta($vk)
    Start-Sleep -Milliseconds 200
    "tecla $Arg1 mantenida $ms ms (INPUT=$([Win32Dbo]::TamInput()) bytes, SendInput devolvio $([Win32Dbo]::UltimoEnvio))"
    if ($Luego) { Captura $hwnd $Luego }
  }
  default { throw "Accion desconocida '$Accion'. Usa: info | captura | tecla" }
}
