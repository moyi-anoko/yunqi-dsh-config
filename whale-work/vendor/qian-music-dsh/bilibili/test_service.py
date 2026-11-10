import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
os.environ.setdefault('QIAN_BILI_DATA', str(Path(tempfile.gettempdir()) / 'qian-bili-unit'))
import service
from credential_store import save_credentials, load_credentials, delete_credentials

class ServiceTests(unittest.TestCase):
    def test_os_encrypted_store_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            value = {'sessdata':'fake-test-only', 'bili_jct':'not-a-real-cookie'}
            save_credentials(root,value)
            self.assertEqual(load_credentials(root),value)
            if os.name == 'nt': self.assertNotIn(b'fake-test-only',(root/'credential.dpapi').read_bytes())
            delete_credentials(root)
            self.assertIsNone(load_credentials(root))

    def test_bv_extraction(self):
        self.assertEqual(service.bvid('https://www.bilibili.com/video/BV1nyxs66EJt/'),'BV1nyxs66EJt')
        with self.assertRaises(ValueError): service.bvid('https://example.org/no-video')

    def test_duplicate_writes_use_receipt_without_reposting(self):
        with tempfile.TemporaryDirectory() as folder:
            calls=[]
            async def dispatch(action,args):
                calls.append((action,args))
                return {'accepted':True,'rpid':'test-receipt'}
            class FakeCred: dedeuserid='test-account'
            lines='\n'.join(json.dumps({'id':i,'action':'comment','args':{'bvid':'BV1nyxs66EJt','text':'test fixture'}}) for i in [1,2])+'\n'
            output=io.StringIO()
            with patch.object(service,'PRIVATE',Path(folder)),patch.object(service,'credential',return_value=FakeCred()),patch.object(service,'dispatch',dispatch),patch.object(service.sys,'stdin',io.TextIOWrapper(io.BytesIO(lines.encode()),encoding='utf-8')):
                with contextlib.redirect_stdout(output):
                    # main() reconfigures real stdout; this wrapper provides the same API.
                    class Capture(io.StringIO):
                        def reconfigure(self,**kwargs): pass
                    capture=Capture()
                    with patch.object(service.sys,'stdout',capture): service.main()
                    result=[json.loads(line) for line in capture.getvalue().splitlines()]
            self.assertEqual(len(calls),1)
            self.assertTrue(result[1]['result']['cached_receipt'])

if __name__=='__main__': unittest.main()
