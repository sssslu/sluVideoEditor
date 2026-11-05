// Notifications can expire between locator.count() and Playwright's stable
// click. Keep real pointer clicks, but accept a toast disappearing on its own.
export async function dismissToasts(page){
  const started=Date.now(),buttons=page.getByTitle('알림 닫기',{exact:true});
  while(await buttons.count()){
    try{await buttons.first().click({timeout:750});}
    catch(error){if(!await buttons.count())return;if(Date.now()-started>5000)throw error;}
  }
}
