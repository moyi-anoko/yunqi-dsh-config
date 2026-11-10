import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {songRecord,rememberSong} from './providers.mjs';
export class Library {
 constructor(root){this.root=root;this.data={version:1,queue:[],mode:'order',volume:0.7,playlists:[]};this.writes=Promise.resolve();}
 async load(){try{this.data={...this.data,...JSON.parse(await readFile(join(this.root,'player-library.json'),'utf8'))};}catch(e){if(e.code!=='ENOENT')throw Error('本地歌单读取失败：'+e.message);}for(const s of [...this.data.queue,...this.data.playlists.flatMap(p=>p.songs)])rememberSong(s);return this;}
 save(){const text=JSON.stringify(this.data,null,2);const write=this.writes.catch(()=>{}).then(async()=>{await mkdir(this.root,{recursive:true});const f=join(this.root,'player-library.json');await writeFile(f+'.tmp',text);await rename(f+'.tmp',f);});this.writes=write;return write;}
 async playlist(action,args={}){
  if(action==='list')return this.data.playlists;
  if(action==='create'){if(!args.name?.trim())throw Error('需要歌单名称');const p={id:randomUUID(),name:args.name.trim(),songs:[]};this.data.playlists.push(p);await this.save();return p;}
  const p=this.data.playlists.find(p=>p.id===args.id);if(!p)throw Error('歌单不存在');
  if(action==='get')return p;
  if(action==='add'){for(const song of args.songs||[])if(!p.songs.some(s=>s.key===song.key))p.songs.push(songRecord(song));}
  else if(action==='remove')p.songs=p.songs.filter(s=>!(args.keys||[]).includes(s.key));
  else if(action==='rename'){if(!args.name?.trim())throw Error('需要歌单名称');p.name=args.name.trim();}
  else if(action==='delete'){if(args.confirm!==true)throw Error('删除整个歌单需要 confirm=true');this.data.playlists=this.data.playlists.filter(x=>x!==p);}
  else throw Error('未知歌单操作');
  await this.save();return action==='delete'?{deleted:p.id}:p;
 }
}
