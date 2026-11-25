# Marks Soul.exe as a windowed app (no black console window).
import struct, sys
p = sys.argv[1]; b = bytearray(open(p, 'rb').read())
pe = struct.unpack_from('<I', b, 0x3c)[0]
assert b[pe:pe+4] == b'PE\0\0'
struct.pack_into('<H', b, pe + 24 + 68, 2)
open(p, 'wb').write(b)
print('GUI subsystem set on', p)
