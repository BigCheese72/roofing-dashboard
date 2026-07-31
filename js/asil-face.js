import * as THREE from "../vendor/three.module.min.js";

(function(){
  "use strict";
  var COPY = { idle:"Ready", listening:"Listening", understanding:"Understanding", thinking:"Thinking", speaking:"Speaking", acting:"Working", needs_attention:"Needs your decision", success:"Complete", error:"Something needs attention" };
  var STYLE = {
    idle:{ color:0x76d7c4, emissive:0x0c4a46, speed:.55, pulse:.018, ring:.22 },
    listening:{ color:0x55c7ff, emissive:0x075e83, speed:1.5, pulse:.055, ring:.8 },
    understanding:{ color:0xa8e0d6, emissive:0x164e63, speed:.85, pulse:.028, ring:.35 },
    thinking:{ color:0xb7a4ff, emissive:0x403070, speed:2.1, pulse:.05, ring:.65 },
    speaking:{ color:0xffd166, emissive:0x8b4f08, speed:1.3, pulse:.07, ring:.72 },
    acting:{ color:0xf49f5c, emissive:0x6d2b0b, speed:1.8, pulse:.042, ring:1 },
    needs_attention:{ color:0xffd166, emissive:0x775006, speed:.75, pulse:.035, ring:.95 },
    success:{ color:0x8ce99a, emissive:0x17612a, speed:.7, pulse:.025, ring:.45 },
    error:{ color:0xff7b7b, emissive:0x7a1717, speed:.45, pulse:.018, ring:.9 }
  };

  function Face(host){
    this.host=host; this.audio=0; this.audioTarget=0; this.state="idle"; this.clock=new THREE.Clock(); this.pointer={x:0,y:0};
    this.reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.scene=new THREE.Scene();
    this.camera=new THREE.PerspectiveCamera(34,1,.1,100); this.camera.position.z=7.2;
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace; this.renderer.toneMapping=THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure=1.15;
    host.appendChild(this.renderer.domElement);
    this.group=new THREE.Group(); this.scene.add(this.group);
    var geometry=new THREE.IcosahedronGeometry(1.62,5); this.base=Float32Array.from(geometry.attributes.position.array);
    this.material=new THREE.MeshPhysicalMaterial({color:0x132e35,emissive:STYLE.idle.emissive,emissiveIntensity:.2,roughness:.08,metalness:.05,transmission:.88,transparent:true,opacity:.36,clearcoat:1,clearcoatRoughness:.05,side:THREE.DoubleSide,depthWrite:false});
    this.mesh=new THREE.Mesh(geometry,this.material); this.group.add(this.mesh);
    this.coreMaterial=new THREE.MeshBasicMaterial({color:0xeaffff,transparent:true,opacity:.92,blending:THREE.AdditiveBlending,depthWrite:false});
    this.core=new THREE.Mesh(new THREE.SphereGeometry(.27,32,24),this.coreMaterial);this.group.add(this.core);
    this.auraMaterial=new THREE.MeshBasicMaterial({color:STYLE.idle.color,transparent:true,opacity:.12,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.BackSide});
    this.aura=new THREE.Mesh(new THREE.SphereGeometry(.48,32,24),this.auraMaterial);this.group.add(this.aura);
    this.filaments=[];
    for(var filamentIndex=0;filamentIndex<18;filamentIndex++){
      var y=1-(filamentIndex/(17))*2,angle=filamentIndex*2.399963229728653,radial=Math.sqrt(Math.max(0,1-y*y));
      var direction=new THREE.Vector3(Math.cos(angle)*radial,y,Math.sin(angle)*radial);
      var filamentGeometry=new THREE.BufferGeometry();filamentGeometry.setAttribute("position",new THREE.BufferAttribute(new Float32Array(27*3),3));
      var filamentMaterial=new THREE.LineBasicMaterial({color:STYLE.idle.color,transparent:true,opacity:.58,blending:THREE.AdditiveBlending,depthWrite:false});
      var filament=new THREE.Line(filamentGeometry,filamentMaterial);filament.frustumCulled=false;this.group.add(filament);
      this.filaments.push({line:filament,direction:direction,phase:filamentIndex*.83,twist:.7+(filamentIndex%5)*.11});
    }
    this.ringMaterial=new THREE.MeshBasicMaterial({color:STYLE.idle.color,transparent:true,opacity:.25});
    this.ring=new THREE.Mesh(new THREE.TorusGeometry(2.05,.018,12,180),this.ringMaterial); this.ring.rotation.x=Math.PI*.54; this.group.add(this.ring);
    var key=new THREE.PointLight(0xd8f7ff,22,15,2); key.position.set(3.2,3,4.5); this.scene.add(key);
    var fill=new THREE.PointLight(0xffb869,14,12,2); fill.position.set(-4,-2,2.5); this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xbfe8ff,0x18201f,2.6));
    var self=this;
    new ResizeObserver(function(){self.resize();}).observe(host);
    host.addEventListener("pointermove",function(event){var r=host.getBoundingClientRect();self.pointer.x=((event.clientX-r.left)/r.width-.5)*2;self.pointer.y=((event.clientY-r.top)/r.height-.5)*2;});
    host.addEventListener("pointerleave",function(){self.pointer.x=0;self.pointer.y=0;});
    this.resize(); this.animate();
  }
  Face.prototype.resize=function(){var w=Math.max(1,this.host.clientWidth),h=Math.max(1,this.host.clientHeight);this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.position.z=w<640?8.4:7.2;this.camera.updateProjectionMatrix();};
  Face.prototype.setState=function(state){this.state=state;};
  Face.prototype.setAudio=function(value){this.audioTarget=Math.max(0,Math.min(1,value||0));};
  Face.prototype.deform=function(time,style){
    var p=this.mesh.geometry.attributes.position,b=this.base,motion=this.reduced?.18:1;
    for(var i=0;i<p.count;i++){var n=i*3,x=b[n],y=b[n+1],z=b[n+2],len=Math.sqrt(x*x+y*y+z*z)||1;var wave=Math.sin(x*3.2+time*style.speed)*Math.cos(y*2.8-time*style.speed*.7);var voice=Math.sin((y+z)*7+time*8)*this.audio*.08;var amount=(style.pulse*wave+voice)*motion;p.setXYZ(i,x+x/len*amount,y+y/len*amount,z+z/len*amount);}
    p.needsUpdate=true; this.mesh.geometry.computeVertexNormals();
  };
  Face.prototype.animateFilaments=function(time,style){
    var energy=.7+this.audio*1.25+((this.state==="listening"||this.state==="speaking") ? .28 : 0);
    for(var f=0;f<this.filaments.length;f++){
      var item=this.filaments[f],position=item.line.geometry.attributes.position,d=item.direction;
      var axis=Math.abs(d.y)<.85?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0),side=new THREE.Vector3().crossVectors(d,axis).normalize(),up=new THREE.Vector3().crossVectors(d,side).normalize();
      for(var i=0;i<27;i++){
        var p=i/26,radius=1.5*p,edgeFade=Math.sin(Math.PI*p),branch=Math.sin((p*10+time*3.2)*item.twist+item.phase)*.095*edgeFade*energy;
        var fork=Math.cos(p*17-time*2.1+item.phase)*.06*edgeFade*energy;
        position.setXYZ(i,d.x*radius+side.x*branch+up.x*fork,d.y*radius+side.y*branch+up.y*fork,d.z*radius+side.z*branch+up.z*fork);
      }
      position.needsUpdate=true;item.line.material.opacity=.34+energy*.18+Math.sin(time*5+item.phase)*.08;item.line.material.color.lerp(new THREE.Color(style.color),.08);
    }
    this.core.scale.setScalar(1+Math.sin(time*5)*.12+this.audio*.35);this.aura.scale.setScalar(1+Math.sin(time*2.4)*.16+this.audio*.28);
    this.coreMaterial.color.lerp(new THREE.Color(style.color).lerp(new THREE.Color(0xffffff),.72),.12);this.auraMaterial.color.lerp(new THREE.Color(style.color),.1);
    this.auraMaterial.opacity=.1+this.audio*.16+Math.sin(time*2.4)*.025;
  };
  Face.prototype.animate=function(){
    var self=this;requestAnimationFrame(function(){self.animate();});var t=this.clock.getElapsedTime(),s=STYLE[this.state]||STYLE.idle,drift=this.reduced?0:1;
    this.audio+=(this.audioTarget-this.audio)*.18;if(this.state!=="listening"&&this.state!=="speaking")this.audioTarget*=.94;this.deform(t,s);this.animateFilaments(t,s);
    this.group.rotation.y+=(this.pointer.x*.18-this.group.rotation.y)*.035;this.group.rotation.x+=(-this.pointer.y*.12-this.group.rotation.x)*.035;
    this.mesh.rotation.y=t*.08*drift;this.mesh.position.y=Math.sin(t*.7)*.07*drift;this.mesh.scale.setScalar(1+Math.sin(t*s.speed)*s.pulse*.35*drift+this.audio*.035);
    this.ring.rotation.z=t*s.speed*.23*drift;this.ringMaterial.opacity+=(s.ring*.48-this.ringMaterial.opacity)*.06;
    this.material.color.lerp(new THREE.Color(s.color).multiplyScalar(.22),.055);this.material.emissive.lerp(new THREE.Color(s.emissive),.055);this.ringMaterial.color.lerp(new THREE.Color(s.color),.06);
    this.renderer.render(this.scene,this.camera);
  };

  function audioMeter(stream,face){
    var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return function(){};var context=new AC(),analyser=context.createAnalyser();analyser.fftSize=256;context.createMediaStreamSource(stream).connect(analyser);var data=new Uint8Array(analyser.frequencyBinCount),active=true;
    (function sample(){if(!active)return;analyser.getByteFrequencyData(data);var total=0;for(var i=0;i<data.length;i++)total+=data[i];face.setAudio(Math.min(1,total/data.length/85));requestAnimationFrame(sample);})();
    return function(){active=false;face.setAudio(0);context.close();};
  }

  var host=document.getElementById("asil-canvas"),status=document.getElementById("asil-status"),dot=document.getElementById("asil-state-dot"),transcript=document.getElementById("asil-transcript"),input=document.getElementById("asil-command"),mic=document.getElementById("asil-mic"),send=document.getElementById("asil-send"),stop=document.getElementById("asil-stop");
  var machine=new AsilStateMachine("idle"),face=new Face(host),recognition=null,stream=null,stopMeter=function(){},handled=false;
  function showText(text,role){transcript.textContent=text||"";transcript.dataset.role=role||"system";transcript.hidden=!text;}
  machine.subscribe(function(snapshot){face.setState(snapshot.state);document.body.dataset.asilState=snapshot.state;status.textContent=COPY[snapshot.state]||snapshot.state;dot.setAttribute("aria-label",status.textContent);mic.setAttribute("aria-pressed",snapshot.state==="listening"?"true":"false");window.dispatchEvent(new CustomEvent("asil:statechange",{detail:snapshot}));});
  function change(state,detail){try{return machine.transition(state,detail);}catch(error){if(machine.state!=="error")machine.transition("error",{message:error.message});throw error;}}
  function stopListening(next){if(recognition)try{recognition.stop();}catch(e){}stopMeter();stopMeter=function(){};if(stream)stream.getTracks().forEach(function(track){track.stop();});stream=null;if(machine.state==="listening")change(next||"understanding");}
  async function startListening(){
    var Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Recognition){change("needs_attention",{reason:"speech-recognition-unavailable"});showText("Voice recognition is unavailable in this browser.","system");return;}
    try{stream=await navigator.mediaDevices.getUserMedia({audio:true});stopMeter=audioMeter(stream,face);recognition=new Recognition();recognition.continuous=false;recognition.interimResults=true;recognition.lang="en-US";
      recognition.onresult=function(event){var text="";for(var i=event.resultIndex;i<event.results.length;i++)text+=event.results[i][0].transcript;input.value=text.trim();showText(input.value,"user");if(event.results[event.results.length-1].isFinal){stopListening("understanding");submit(input.value);}};
      recognition.onerror=function(event){stopListening("idle");change("error",{reason:event.error});showText("I couldn't hear that clearly.","system");};recognition.onend=function(){if(machine.state==="listening")stopListening("understanding");};
      change("listening");showText("","system");recognition.start();
    }catch(error){change("needs_attention",{reason:"microphone-permission",message:error.message});showText("Microphone access is needed for voice conversation.","system");}
  }
  function speak(text,options){options=options||{};if(!text)return;window.speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(text);u.rate=options.rate||1;u.pitch=options.pitch||.95;u.onstart=function(){if(!machine.canTransition("speaking"))change("idle");change("speaking",{text:text});showText(text,"asil");};u.onboundary=function(){face.setAudio(.25+Math.random()*.55);};u.onend=function(){face.setAudio(0);change("idle");};u.onerror=function(){face.setAudio(0);change("error",{reason:"speech-synthesis"});};window.speechSynthesis.speak(u);}
  function submit(value){
    var text=String(value||input.value||"").trim();if(!text)return;input.value="";if(machine.state==="listening")stopListening("understanding");else change("understanding",{text:text});showText(text,"user");setTimeout(function(){if(machine.state==="understanding")change("thinking",{text:text});},260);handled=false;
    window.dispatchEvent(new CustomEvent("asil:command",{detail:{text:text,respond:function(response){handled=true;speak(response);},setState:function(state,detail){handled=true;change(state,detail);}}}));
    setTimeout(function(){if(!handled&&(machine.state==="thinking"||machine.state==="understanding"))speak("My interface is ready. Claude's backend agent will connect here next.");},1100);
  }
  mic.addEventListener("click",function(){machine.state==="listening"?stopListening("idle"):startListening();});send.addEventListener("click",function(){submit();});stop.addEventListener("click",function(){stopListening("idle");window.speechSynthesis.cancel();if(machine.state!=="idle")change("idle");});input.addEventListener("keydown",function(event){if(event.key==="Enter")submit();});
  document.querySelectorAll("[data-asil-demo-state]").forEach(function(button){button.addEventListener("click",function(){if(machine.state!=="idle")change("idle");change(button.dataset.asilDemoState);});});
  window.ASIL={getState:function(){return machine.snapshot();},setState:change,speak:speak,respond:speak,startListening:startListening,stopListening:stopListening,submit:submit,setAudioLevel:function(level){face.setAudio(level);}};
})();
