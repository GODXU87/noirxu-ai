'use client';
// Tab-local drafts, separate from durable conversation records. No network writes.
const ACTIVE='noirxu-ai-draft-active';
const PREFIX='noirxu-ai-draft:';
export function activeDraft():string|null {try{return sessionStorage.getItem(ACTIVE);}catch{return null;}}
export function readDraft(id:string):string {try{return sessionStorage.getItem(PREFIX+id)??'';}catch{return '';}}
export function draftPending(id:string):boolean {try{return sessionStorage.getItem(PREFIX+id+':pending')==='1';}catch{return false;}}
export function saveDraft(id:string,text:string,pending=false):boolean {
 try {
  if(text){sessionStorage.setItem(PREFIX+id,text);sessionStorage.setItem(ACTIVE,id);}
  else {sessionStorage.removeItem(PREFIX+id);if(sessionStorage.getItem(ACTIVE)===id)sessionStorage.removeItem(ACTIVE);}
  if(pending)sessionStorage.setItem(PREFIX+id+':pending','1');else sessionStorage.removeItem(PREFIX+id+':pending');
  return true;
 }catch{return false;}
}
