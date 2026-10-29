"""Decoder coverage using generated signals, with no personal ECG fixture."""
import math
import struct
import unittest
from ecg_reader import read_record


def fixture():
    blob = bytearray(39381)
    blob[6:20] = b'20000101000000'
    for start, samples in [(79, 1000), (24981, 600)]:
        one = [round(60 * math.sin(i / 15)) for i in range(samples)]
        leads = [[2048 + v for v in one], [2048 + 2 * v for v in one], [2048 + v for v in one]]
        leads.extend([[2048 + v for v in one] for _ in range(9)])
        struct.pack_into('<' + str(samples * 12) + 'H', blob, start, *(v for lead in leads for v in lead))
    struct.pack_into('<5H', blob, 24079, 60, 160, 90, 400, 400)
    struct.pack_into('<11H', blob, 24089, *([1000] * 11))
    return bytes(blob)


class ReaderTest(unittest.TestCase):
    def test_shapes_and_exact_round_trip(self):
        raw = fixture()
        result = read_record(raw)
        self.assertEqual(len(result['block_A']), 12)
        self.assertEqual(len(result['block_A'][0]), 1000)
        self.assertEqual(len(result['block_B'][0]), 600)
        rebuilt = struct.pack('<7200H', *(v for lead in result['block_B'] for v in lead))
        self.assertEqual(rebuilt, raw[24981:])

    def test_bad_size_id_and_adc(self):
        raw = fixture()
        damaged = bytearray(raw)
        struct.pack_into('<H', damaged, 24981, 65535)
        for item in [raw[:-1], raw + b'0', raw[:6] + b'x' + raw[7:], bytes(damaged)]:
            with self.subTest(), self.assertRaises((ValueError, UnicodeError)):
                read_record(item)


if __name__ == '__main__':
    unittest.main()
