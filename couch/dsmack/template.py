# python3 couch/dsmack/template.py MANIFEST POLICY: write MANIFEST (a key-free guest compose manifest) into POLICY's manifestTemplate with
# the runner CDHash (compose command[5]) and PAYMENTS_CONFIG node and operator blanked.
import json,sys
from pathlib import Path
c=lambda v: json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False)
raw=Path(sys.argv[1]).read_bytes();m=json.loads(raw);assert c(m).encode()==raw,'manifest is not canonical'
comp=json.loads(m['docker_compose_file']);node=comp['services']['node'];env=node['environment'];pay=json.loads(env['PAYMENTS_CONFIG'])
assert 'enrollmentKeyId' not in pay,'manifest pins an App Attest key'
cdhash=node['command'][5];node['command'][5]=''
env['PAYMENTS_CONFIG']=c({**pay,'node':'','operator':''});m['docker_compose_file']=c(comp)
p=Path(sys.argv[2]);policy=json.loads(p.read_text());policy['manifestTemplate']=c(m).encode().hex();p.write_text(json.dumps(policy,separators=(",",":")))
print(json.dumps({'cdhash':cdhash,'node':pay['node'],'operator':pay['operator']}))
