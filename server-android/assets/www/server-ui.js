(function(){
  'use strict';
  const form=document.getElementById('settingsForm');
  if(!form)return;
  // A required field in a closed group must remain reachable on validation.
  form.addEventListener('invalid',function(event){
    for(let parent=event.target.parentElement;parent&&parent!==form;parent=parent.parentElement){if(parent.tagName==='DETAILS')parent.open=true;}
  },true);
  document.querySelectorAll('[data-open-setting]').forEach(function(button){button.addEventListener('click',function(){
    document.querySelector('[data-tab="settings"]').click();
    const group=document.getElementById(button.dataset.openSetting);if(!group)return;
    group.open=true;group.scrollIntoView({block:'start',behavior:'auto'});group.querySelector('summary').focus({preventScroll:true});
  });});
}());
