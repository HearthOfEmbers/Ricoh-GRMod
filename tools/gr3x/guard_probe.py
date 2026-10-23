"""Round 7: the settings guard (core/src/fw/gr3x/guard.ts), executed in the built image.

`fix(record)` and `fixAll(settings object)` are called on records of random bytes: every photo and
movie look that is not one of the camera's own (11..22) or a film of the build becomes Standard,
a ratio above the build's largest identity becomes 3:2, and no other byte changes. The mode
recall runs natively from the copy of the stored record to just before the record goes to the live
values; the settings load and save hooks run natively with the firmware's load and save
substituted (the save must see guarded records). This does not establish the camera's menus.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

LOOKS=(0x1c2,0x1c4,0x1c6,0x57e,0x580,0x582);RATIO=0x4c2;SIZE=0xb28
LOAD_DATA,LOAD_CALL,SAVE_DATA,SAVE_CALL,MEMCPY=0x5324b284,0x5324b754,0x5323f274,0x5322b0a8,0x5313fd80
RECALL_FROM,RECALL_TO=0x53279fec,0x5327a008
REGION=0x63000000;UD=REGION;RECS=REGION+0x1000

def guarded(rec,films,max_ratio):
    out=bytearray(rec)
    for off in LOOKS:
        v=out[off]
        if not (11<=v<=22 or 64<=v<64+films):out[off]=11
    if out[RATIO]>max_ratio:out[RATIO]=0
    return bytes(out)

class GuardProbe(AdjProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest);self.uc.mem_map(REGION,0x40000);self.loads=0;self.saves=[]
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        if at==LOAD_DATA:
            assert r(0)==UD;self.loads+=1;cpu.reg_write(reg.UC_ARM_REG_R0,0x77);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==SAVE_DATA:
            assert r(0)==UD;self.saves.append([bytes(cpu.mem_read(RECS+i*0x1000,SIZE)) for i in range(8)])
            cpu.reg_write(reg.UC_ARM_REG_R0,0x5a);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)
    def records(self,rng,pointers=True):
        recs=[bytes(rng.randrange(256) for _ in range(SIZE)) for _ in range(8)]
        for i,rec in enumerate(recs):self.uc.mem_write(RECS+i*0x1000,rec)
        ud=bytearray(0x40)
        for i in range(8):
            if pointers or i%3:struct.pack_into('<I',ud,4+4*i,RECS+i*0x1000)
        self.uc.mem_write(UD,bytes(ud));return recs,ud
    def run(self,start,stop,regs):
        cpu=self.uc
        for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),regs.get(i,0x1230+i))
        cpu.reg_write(reg.UC_ARM_REG_SP,STACK);cpu.reg_write(reg.UC_ARM_REG_LR,STOP);cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        cpu.emu_start(start,stop,count=200000)
        assert cpu.reg_read(reg.UC_ARM_REG_PC)==stop and cpu.reg_read(reg.UC_ARM_REG_SP)==STACK

def entries_of(manifest):
    """The guard's entries: in the adj layer (no films) or with the films' own parameters."""
    e=manifest['entries']
    if 'guardFixAll' in e:return dict(fix=e['guardFix'],fixAll=e['guardFixAll'],recall=e['guardRecall'],films=0,own=False)
    own=manifest['lookEntries']['ownParameters']
    return dict(fix=own['guardFix'],fixAll=own['guardFixAll'],recall=own['guardRecall'],films=manifest['filmCount'],own=True)

def verify(data,manifest,seed=1107,rounds=400):
    g=entries_of(manifest);films=g['films'];max_ratio=max(r['id'] for r in manifest['menu'])
    assert max_ratio==3+sum(1 for r in manifest['menu'] if r['id']>=4)
    p=GuardProbe(data,manifest);cpu=p.uc;rng=random.Random(seed+films*31+max_ratio);calls=0;fixed=0
    # The hook sites point at the guard.
    sites={s['address']:s for s in manifest['sites']}
    for at in (LOAD_CALL,SAVE_CALL,0x5327a004):assert at in sites and 'guard' in sites[at]['reason'],hex(at)
    # 1. fix(record): every value of every look and of the ratio, then random records.
    for v in range(256):
        rec=bytearray(rng.randrange(256) for _ in range(SIZE))
        for off in LOOKS:rec[off]=v
        rec[RATIO]=v;cpu.mem_write(RECS,bytes(rec))
        assert p.call(g['fix'],RECS) is not None;calls+=1
        got=bytes(cpu.mem_read(RECS,SIZE));assert got==guarded(rec,films,max_ratio),v
        fixed+=got!=bytes(rec)
    assert p.call(g['fix'],0)==0;calls+=1
    for _ in range(rounds):
        recs,ud=p.records(rng,pointers=rng.random()<0.7)
        p.call(g['fixAll'],UD);calls+=1
        for i,rec in enumerate(recs):
            ptr=struct.unpack_from('<I',ud,4+4*i)[0]
            assert bytes(cpu.mem_read(RECS+i*0x1000,SIZE))==(guarded(rec,films,max_ratio) if ptr else rec),i
        assert bytes(cpu.mem_read(UD,0x40))==bytes(ud)
    p.call(g['fixAll'],0);calls+=1
    # 2. The mode recall: the stored record copied into use, then guarded (the stored one unchanged).
    for _ in range(64):
        recs,ud=p.records(rng);mode=rng.randrange(7)
        p.run(RECALL_FROM,RECALL_TO,{5:UD,6:mode});calls+=1
        src=recs[1+mode]
        assert bytes(cpu.mem_read(RECS,0xb26))==guarded(src,films,max_ratio)[:0xb26]
        assert bytes(cpu.mem_read(RECS+(1+mode)*0x1000,SIZE))==src
    # 3. Load and save (without films; with films slots_probe runs them with the films' table).
    load_save=False
    if not g['own']:
        recs,ud=p.records(rng);p.run(LOAD_CALL,LOAD_CALL+4,{0:UD,4:UD});calls+=1
        assert p.loads==1 and cpu.reg_read(reg.UC_ARM_REG_R4)==UD
        for i,rec in enumerate(recs):assert bytes(cpu.mem_read(RECS+i*0x1000,SIZE))==guarded(rec,films,max_ratio)
        recs,ud=p.records(rng);p.run(SAVE_CALL,STOP,{0:UD});calls+=1
        assert cpu.reg_read(reg.UC_ARM_REG_R0)==0x5a and len(p.saves)==1
        assert p.saves[0]==[guarded(rec,films,max_ratio) for rec in recs]
        load_save=True
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,max_ratio=max_ratio,calls=calls,
        values_changed=fixed,load_and_save_run=load_save,seed=seed,hardware_tested=False,
        scope='Guard functions called directly; the mode recall, load and save hooks run natively with the firmware load/save substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    a=a.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
