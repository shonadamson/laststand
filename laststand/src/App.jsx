import { useState, useEffect, useCallback, useRef } from "react";
import { loadLeagueState, saveLeagueState, subscribeToState } from "./supabase.js";
import { NFL_ROSTERS, NFL_TEAMS as TEAM_LIST } from "./rosters.js";

const ADMIN_PASSWORD = "nfl2024";

const DEFAULT_THRESHOLDS = {
  rb:        { rushRecYds: 65 },
  passing:   { passYds: 220 },
  receiving: { recYds: 40 },
  tfl:       { requireAny: true },
  defense:   { maxPointsAllowed: 26 },
  offense:   { minPointsScored: 21 },
  td:        { requireAny: true, minLongPlayYds: 20 },
  kicker:    { minKickerPts: 5 },
  win:       { requireWin: true },
  loss:      { requireLoss: true },
};

const CATEGORY_META = [
  { id:"rb",        name:"RB Rushing/Receiving",   type:"player", positions:["RB"],                icon:"🏃",
    fields:[{key:"rushRecYds",label:"Min Rush+Rec Yards",min:0,max:300}],
    descFn:(t)=>`${t.rushRecYds}+ rush/rec yds`,
    grade:(s,t)=>(s.rushingYards||0)+(s.receivingYards||0)>=t.rushRecYds },
  { id:"passing",   name:"Passing",                type:"player", positions:["QB"],                icon:"🎯",
    fields:[{key:"passYds",label:"Min Passing Yards",min:0,max:600}],
    descFn:(t)=>`${t.passYds}+ pass yds`,
    grade:(s,t)=>(s.passingYards||0)>=t.passYds },
  { id:"receiving", name:"Receiving",              type:"player", positions:["WR","TE","RB"],      icon:"🙌",
    fields:[{key:"recYds",label:"Min Receiving Yards",min:0,max:300}],
    descFn:(t)=>`${t.recYds}+ rec yds`,
    grade:(s,t)=>(s.receivingYards||0)>=t.recYds },
  { id:"tfl",       name:"TFL / Turnover / QB Hit",type:"player", positions:["DEF_PLAYER"],        icon:"💥",
    fields:[],
    descFn:()=>"TFL, sack, forced TO, or QB hit",
    grade:(s)=>(s.tacklesForLoss||0)>0||(s.sacks||0)>0||(s.forcedFumbles||0)>0||(s.interceptions||0)>0||(s.qbHits||0)>0 },
  { id:"defense",   name:"Defense",               type:"team",   positions:["TEAM"],              icon:"🛡️",
    fields:[{key:"maxPointsAllowed",label:"Max Points Allowed",min:0,max:60}],
    descFn:(t)=>`Hold opponent to ≤${t.maxPointsAllowed} pts`,
    grade:(s,t)=>(s.opponentScore??999)<=t.maxPointsAllowed },
  { id:"offense",   name:"Offense",               type:"team",   positions:["TEAM"],              icon:"⚡",
    fields:[{key:"minPointsScored",label:"Min Points Scored",min:0,max:60}],
    descFn:(t)=>`Score ${t.minPointsScored}+ pts`,
    grade:(s,t)=>(s.teamScore||0)>=t.minPointsScored },
  { id:"td",        name:"TD / 2PT / Long Play",  type:"player", positions:["QB","RB","WR","TE"], icon:"🏆",
    fields:[{key:"minLongPlayYds",label:"Min Long Play Yards",min:0,max:99}],
    descFn:(t)=>`TD, 2PT conv, or ${t.minLongPlayYds}+ yd play`,
    grade:(s,t)=>(s.touchdowns||0)>0||(s.twoPointConversions||0)>0||(s.longRush||0)>=t.minLongPlayYds||(s.longReception||0)>=t.minLongPlayYds },
  { id:"kicker",    name:"Kicker",                type:"player", positions:["K"],                 icon:"🦵",
    fields:[{key:"minKickerPts",label:"Min Kicker Points (FG×3 + XP made − missed XP)",min:0,max:30}],
    descFn:(t)=>`${t.minKickerPts}+ pts (FG×3 + XP made − missed XP)`,
    grade:(s,t)=>((s.fieldGoalsMade||0)*3+(s.extraPointsMade||0)-(s.extraPointsMissed||0))>=t.minKickerPts },
  { id:"win",       name:"Team Win",              type:"team",   positions:["TEAM"],              icon:"✅",
    fields:[],
    descFn:()=>"Your team wins",
    grade:(s)=>s.won===true },
  { id:"loss",      name:"Team Loss",             type:"team",   positions:["TEAM"],              icon:"❌",
    fields:[],
    descFn:()=>"Your team loses",
    grade:(s)=>s.won===false },
];

const DEF_POSITIONS = ["DT","DE","LB","CB","S","MLB","OLB","ILB","FS","SS","NT","DL","DB"];
const AVATAR_COLORS = ["#e8ff3c","#3cff8a","#ff6b6b","#6bc5ff","#ff9f43","#a29bfe","#fd79a8","#00cec9"];

const initialState = {
  users:[], currentWeek:1,
  picks:{}, results:{}, eliminations:{}, weekLocked:{},
  gradingResults:{}, thresholds:DEFAULT_THRESHOLDS, customPlayers:[],
};

function hashPassword(pw) {
  let h=0; for(let i=0;i<pw.length;i++) h=Math.imul(31,h)+pw.charCodeAt(i)|0; return h.toString(36);
}
function fuzzyMatch(a,b) {
  a=a.toLowerCase().replace(/[^a-z]/g,""); b=b.toLowerCase().replace(/[^a-z]/g,"");
  if(a===b) return 1;
  if(a.includes(b)||b.includes(a)) return 0.85;
  const shorter=a.length<b.length?a:b,longer=a.length<b.length?b:a;
  let matches=0;
  for(let i=0;i<shorter.length;i++) if(longer.includes(shorter[i])) matches++;
  return matches/longer.length;
}

// ESPN APIs — with CORS proxy fallback
// Route ESPN calls through our own Vercel serverless function to avoid CORS
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

async function espnFetch(path) {
  const url = `${ESPN_BASE}/${path}`;
  // Try 1: Direct browser request (works from some networks)
  try {
    const r = await fetch(url);
    if (r.ok) return r.json();
  } catch {}
  // Try 2: Our Vercel serverless proxy
  try {
    const r = await fetch(`/api/espn?path=${encodeURIComponent(path)}`);
    if (r.ok) return r.json();
  } catch {}
  // Try 3: Public CORS proxy
  try {
    const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
    if (r.ok) return r.json();
  } catch {}
  throw new Error("All ESPN fetch attempts failed");
}

async function fetchAllTeams() {
  const d = await espnFetch("teams?limit=32");
  return d.sports[0].leagues[0].teams.map(t=>({
    id:t.team.id, abbr:t.team.abbreviation, name:t.team.displayName, short:t.team.shortDisplayName,
  }));
}
async function fetchRosterForTeam(teamId) {
  const d = await espnFetch(`teams/${teamId}/roster`);
  const players=[];
  (d.athletes||[]).forEach(g=>(g.items||[]).forEach(p=>players.push({
    id:p.id, name:p.fullName, pos:p.position?.abbreviation||"", teamAbbr:d.team?.abbreviation||"", teamId,
  })));
  return players;
}
async function fetchWeekScoreboard(week) {
  return espnFetch(`scoreboard?week=${week}&seasontype=2`);
}
async function fetchGameStats(gameId) {
  return espnFetch(`summary?event=${gameId}`);
}

// Returns { teamAbbr -> kickoffTime (Date) } for the current week
async function fetchKickoffTimes(week) {
  try {
    const d = await espnFetch(`scoreboard?week=${week}&seasontype=2`);
    const map={};
    (d.events||[]).forEach(event=>{
      const kickoff=new Date(event.date);
      (event.competitions||[]).forEach(comp=>{
        (comp.competitors||[]).forEach(c=>{
          if(c.team?.abbreviation) map[c.team.abbreviation]=kickoff;
          if(c.team?.displayName) map[c.team.displayName]=kickoff;
          if(c.team?.shortDisplayName) map[c.team.shortDisplayName]=kickoff;
        });
      });
    });
    return map;
  } catch { return {}; }
}

function parsePlayerStats(gameData) {
  const stats={}; const teamScores={};
  try {
    (gameData.header?.competitions||[]).forEach(comp=>{
      const competitors=comp.competitors||[];
      if(competitors.length===2){
        const [home,away]=competitors;
        const ha=home.team?.abbreviation, aa=away.team?.abbreviation;
        const hs=parseInt(home.score||0), as_=parseInt(away.score||0);
        if(ha) teamScores[ha]={teamScore:hs,opponentScore:as_,won:hs>as_};
        if(aa) teamScores[aa]={teamScore:as_,opponentScore:hs,won:as_>hs};
      }
    });
    (gameData.boxscore?.players||[]).forEach(teamData=>{
      const teamAbbr=teamData.team?.abbreviation||"";
      (teamData.statistics||[]).forEach(statGroup=>{
        const keys=statGroup.keys||[];
        (statGroup.athletes||[]).forEach(athlete=>{
          const name=athlete.athlete?.displayName||"";
          if(!name) return;
          const vals=athlete.stats||[];
          const obj={teamAbbr};
          keys.forEach((k,i)=>{obj[k]=isNaN(vals[i])?vals[i]:parseFloat(vals[i]||0);});
          stats[name]={
            passingYards:obj["passingYards"]||0,
            rushingYards:obj["rushingYards"]||0,
            receivingYards:obj["receivingYards"]||0,
            touchdowns:(obj["passingTouchdowns"]||0)+(obj["rushingTouchdowns"]||0)+(obj["receivingTouchdowns"]||0),
            twoPointConversions:obj["twoPointConversions"]||0,
            longRush:obj["longRushing"]||0,
            longReception:obj["longReception"]||0,
            longPass:obj["longPassing"]||0,
            tacklesForLoss:obj["tacklesForLoss"]||0,
            sacks:obj["sacks"]||0,
            forcedFumbles:obj["fumblesForced"]||0,
            interceptions:obj["interceptions"]||0,
            qbHits:obj["QBHits"]||0,
            fieldGoalsMade:obj["fieldGoalsMade"]||0,
            extraPointsMade:obj["extraPointsMade"]||0,
            extraPointsMissed:obj["extraPointsMissed"]||0,
            teamAbbr,
          };
        });
      });
    });
  } catch(e){console.warn("Parse error",e);}
  return {playerStats:stats,teamStats:teamScores};
}

export default function App() {
  const [state,setState]=useState(initialState);
  const [dbLoading,setDbLoading]=useState(true);
  const [dbError,setDbError]=useState(null);
  const [loggedInUser,setLoggedInUser]=useState(null);
  const [adminAuthed,setAdminAuthed]=useState(false);
  const [adminTab,setAdminTab]=useState("grade");
  const [adminNewUn,setAdminNewUn]=useState("");
  const [adminNewPw,setAdminNewPw]=useState("");
  const [adminNewTn,setAdminNewTn]=useState("");
  const [adminResultInputs,setAdminResultInputs]=useState({});
  const [view,setView]=useState("login");
  const [notification,setNotification]=useState(null);
  const [teams]=useState(TEAM_LIST);
  const [allPlayers,setAllPlayers]=useState(NFL_ROSTERS);
  useEffect(()=>{ setAllPlayers([...NFL_ROSTERS,...(state.customPlayers||[])]); },[state.customPlayers]);
  const rosterLoading=false;
  const rosterLoaded=true;
  const rosterError=null;
  const [kickoffTimes,setKickoffTimes]=useState({}); // { teamName/abbr -> Date }
  const [now,setNow]=useState(new Date());



  // Load initial state from Supabase
  useEffect(()=>{
    loadLeagueState().then(s=>{
      if(s) setState(s);
      setDbLoading(false);
    }).catch(()=>{setDbError("Could not connect to database.");setDbLoading(false);});
  },[]);

  // Subscribe to real-time updates from other users
  const lastSaveTime = useRef(0);
  useEffect(()=>{
    const sub=subscribeToState(remoteState=>{
      // Only apply remote state if we haven't saved in the last 2 seconds
      // to avoid overwriting our own just-saved state
      if(Date.now() - lastSaveTime.current > 2000){
        setState(remoteState);
      }
    });
    return ()=>{ sub.unsubscribe(); };
  },[]);

  // Save to Supabase whenever state changes
  useEffect(()=>{
    if(dbLoading) return;
    lastSaveTime.current = Date.now();
    saveLeagueState(state).then(success=>{
      if(!success) console.error('Failed to save state');
    });
  },[state,dbLoading]);

  // Tick clock every minute to re-check kickoff locks
  useEffect(()=>{
    const t=setInterval(()=>setNow(new Date()),60000);
    return ()=>clearInterval(t);
  },[]);

  // Load kickoff times when week changes or user logs in
  useEffect(()=>{
    if(!loggedInUser) return;
    fetchKickoffTimes(state.currentWeek).then(setKickoffTimes).catch(()=>{});
  },[state.currentWeek,loggedInUser]);

  // Check if a given team name/abbr has already kicked off
  const hasGameStarted=(teamNameOrAbbr)=>{
    if(!teamNameOrAbbr) return false;
    const search=teamNameOrAbbr.toLowerCase().trim();
    // Exact match only — no fuzzy matching to avoid false locks
    const key=Object.keys(kickoffTimes).find(k=>{
      const k2=k.toLowerCase().trim();
      return k2===search;
    });
    if(!key) return false;
    return now >= kickoffTimes[key];
  };

  // For a player pick, find their team and check kickoff
  const isPlayerGameStarted=(playerName)=>{
    const player=allPlayers.find(p=>p.name===playerName);
    if(!player?.teamAbbr) return false;
    return hasGameStarted(player.teamAbbr);
  };

  // For a team pick, check kickoff directly
  const isTeamGameStarted=(teamName)=>hasGameStarted(teamName);

  const notify=(msg,type="success")=>{
    setNotification({msg,type}); setTimeout(()=>setNotification(null),3500);
  };



  const CATEGORIES=CATEGORY_META.map(cat=>{
    const t=state.thresholds?.[cat.id]||DEFAULT_THRESHOLDS[cat.id]||{};
    return{...cat,description:cat.descFn(t),gradeWithThreshold:(s)=>cat.grade(s,t)};
  });

  // Auth
  const login=(username,password)=>{
    // Trim whitespace to avoid accidental spaces causing login failures
    const user=state.users.find(u=>u.username.toLowerCase()===username.trim().toLowerCase()&&u.passwordHash===hashPassword(password.trim()));
    if(!user){notify("Invalid username or password","error");return;}
    setLoggedInUser(user); setView("home");
  };
  const register=async(username,password,teamName)=>{
    if(!username.trim()||!password.trim()||!teamName.trim()){notify("All fields required","error");return;}
    if(state.users.find(u=>u.username.toLowerCase()===username.toLowerCase())){notify("Username taken","error");return;}
    const color=AVATAR_COLORS[state.users.length%AVATAR_COLORS.length];
    const newUser={id:Date.now().toString(),username:username.trim(),passwordHash:hashPassword(password.trim()),teamName:teamName.trim(),avatarColor:color};
    const newState={...state,users:[...state.users,newUser]};
    setState(newState);
    // Force immediate save so the user appears for everyone right away
    const success = await saveLeagueState(newState);
    if(!success) notify("Warning: account may not have saved — please try again","error");
    setLoggedInUser(newUser); setView("home"); notify(`Welcome, ${teamName}! 🏈`);
  };
  const logout=()=>{setLoggedInUser(null);setAdminAuthed(false);setView("login");};

  const getUsedPicks=(userId,categoryId)=>{
    const used=[];
    Object.keys(state.picks).forEach(wk=>{const p=state.picks[wk]?.[userId]?.[categoryId];if(p) used.push(p);});
    return used;
  };
  const isEliminated=(userId,categoryId)=>state.eliminations?.[userId]?.[categoryId]===true;
  const isWeekLocked=(week)=>state.weekLocked?.[`w${week}`]===true;

  const makePick=(userId,categoryId,pickLabel)=>{
    const weekKey=`w${state.currentWeek}`;
    if(getUsedPicks(userId,categoryId).includes(pickLabel)){notify("Already used that pick!","error");return;}
    setState(s=>({...s,picks:{...s.picks,[weekKey]:{...(s.picks[weekKey]||{}),[userId]:{...(s.picks[weekKey]?.[userId]||{}),[categoryId]:pickLabel}}}}));
    notify("Pick saved! ✅");
  };

  const applyApprovedGrades=(weekNum,gradingData)=>{
    const weekKey=`w${weekNum}`;
    const weekPicks=state.picks[weekKey]||{};
    const newResults={};

    // Recalculate eliminations from scratch across ALL weeks
    // This ensures re-grading correctly fixes mistakes
    const newElims={};

    // First pass: collect all week results including this week's new grades
    const allResults={...state.results};
    CATEGORIES.forEach(cat=>{
      const catGrades=gradingData[cat.id]||{};
      const successfulPicks=Object.entries(catGrades).filter(([,v])=>v.passed).map(([k])=>k);
      newResults[cat.id]=successfulPicks;
      allResults[weekKey]={...allResults[weekKey],[cat.id]:successfulPicks};
    });

    // Second pass: replay all weeks to recalculate eliminations correctly
    CATEGORIES.forEach(cat=>{
      state.users.forEach(user=>{
        // Check each week in order
        const weeks=Object.keys(state.picks).sort();
        for(const wk of weeks){
          if(newElims[user.id]?.[cat.id]) break; // already eliminated
          const pick=state.picks[wk]?.[user.id]?.[cat.id];
          const weekResults=allResults[wk]?.[cat.id]||[];
          // If results exist for this week and pick failed (or no pick), eliminate
          if(allResults[wk] && allResults[wk][cat.id] !== undefined){
            if(!pick||!weekResults.includes(pick)){
              if(!newElims[user.id]) newElims[user.id]={};
              newElims[user.id][cat.id]=true;
            }
          }
        }
      });
    });

    setState(s=>({...s,eliminations:newElims,results:{...s.results,[weekKey]:newResults},weekLocked:{...s.weekLocked,[weekKey]:true},gradingResults:{...s.gradingResults,[weekKey]:gradingData}}));
    notify("Week approved & published! 🏈");
  };

  const searchPlayers=(query,positions)=>{
    if(!query||query.length<2) return [];
    const q=query.toLowerCase();
    if(!positions||positions.length===0) return allPlayers.filter(p=>p.name.toLowerCase().includes(q)).slice(0,10);
    const isDef=positions.includes("DEF_PLAYER");
    return allPlayers.filter(p=>{
      if(!p.name.toLowerCase().includes(q)) return false;
      if(isDef) return DEF_POSITIONS.includes(p.pos);
      return positions.some(pos=>pos===p.pos);
    }).slice(0,10);
  };
  const searchTeams=(query)=>{
    if(!query) return [];
    const q=query.toLowerCase();
    return TEAM_LIST.filter(t=>t.name.toLowerCase().includes(q)||t.abbr.toLowerCase().includes(q)||t.short.toLowerCase().includes(q)).slice(0,8);
  };
  const getStandings=()=>
    state.users.map(u=>({...u,alive:CATEGORIES.filter(c=>!isEliminated(u.id,c.id)).length,elim:CATEGORIES.filter(c=>isEliminated(u.id,c.id)).length}))
      .sort((a,b)=>b.alive-a.alive);

  const Avatar=({user,size=36})=>(
    <div style={{width:size,height:size,borderRadius:"50%",background:user.avatarColor||"#e8ff3c",color:"#000",fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*.44,flexShrink:0}}>
      {user.teamName?.[0]?.toUpperCase()||user.username?.[0]?.toUpperCase()}
    </div>
  );

  // ── USER ADMIN ROW ───────────────────────────────────────────────────────────
  const UserAdminRow=({user, onReset, onRemove, Avatar})=>{
    const [showReset, setShowReset]=useState(false);
    const [newPw, setNewPw]=useState("");
    const [newPw2, setNewPw2]=useState("");
    return(
      <div style={{background:"var(--surface2)",borderRadius:8,marginBottom:8,overflow:"hidden"}}>
        <div className="player-admin-row">
          <Avatar user={user} size={36}/>
          <div className="padmin-info">
            <span className="padmin-team">{user.teamName}</span>
            <span className="padmin-un">@{user.username}</span>
          </div>
          <button style={{background:"none",border:"1px solid var(--border)",color:"var(--muted)",fontSize:11,padding:"4px 8px",borderRadius:6,cursor:"pointer",marginRight:6}} onClick={()=>{setShowReset(!showReset);setNewPw("");setNewPw2("");}}>
            {showReset?"Cancel":"🔑 Reset PW"}
          </button>
          <button className="remove-btn" onClick={onRemove}>✕</button>
        </div>
        {showReset&&(
          <div style={{padding:"10px 14px",borderTop:"1px solid var(--border)",display:"flex",flexDirection:"column",gap:8}}>
            <input className="admin-input" type="password" placeholder="New password (min 4 chars)" value={newPw} onChange={e=>setNewPw(e.target.value)}/>
            <input className="admin-input" type="password" placeholder="Confirm new password" value={newPw2} onChange={e=>setNewPw2(e.target.value)}/>
            <button style={{background:"var(--accent)",color:"#000",border:"none",padding:"8px",borderRadius:8,cursor:"pointer",fontWeight:700,fontSize:13}} onClick={()=>{
              if(newPw!==newPw2){alert("Passwords don't match");return;}
              if(newPw.length<4){alert("Password must be 4+ characters");return;}
              onReset(user.id, newPw);
              setShowReset(false);setNewPw("");setNewPw2("");
            }}>Save New Password</button>
          </div>
        )}
      </div>
    );
  };

  // ── ADD PLAYER FORM ──────────────────────────────────────────────────────────
  const AddPlayerForm=({state,setState,notify})=>{
    const [name,setName]=useState("");
    const [pos,setPos]=useState("QB");
    const [team,setTeam]=useState("KC");
    const positions=["QB","RB","WR","TE","K","DE","DT","LB","CB","S","OLB","MLB","ILB","FS","SS"];
    const teamAbbrs=["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LV","LAC","LAR","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SF","SEA","TB","TEN","WSH"];
    const add=()=>{
      if(!name.trim()){notify("Player name required","error");return;}
      const existing=[...NFL_ROSTERS,...(state.customPlayers||[])].find(p=>p.name.toLowerCase()===name.trim().toLowerCase());
      if(existing){notify("Player already exists in roster","error");return;}
      setState(s=>({...s,customPlayers:[...(s.customPlayers||[]),{name:name.trim(),pos,teamAbbr:team}]}));
      setName(""); notify(`${name.trim()} added! ✅`);
    };
    return(
      <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--radius)",padding:16,marginBottom:16}}>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <input className="admin-input" placeholder="Player full name" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()}/>
          <div style={{display:"flex",gap:8}}>
            <select className="admin-input" value={pos} onChange={e=>setPos(e.target.value)} style={{flex:1}}>
              {positions.map(p=><option key={p} value={p}>{p}</option>)}
            </select>
            <select className="admin-input" value={team} onChange={e=>setTeam(e.target.value)} style={{flex:1}}>
              {teamAbbrs.map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <button className="confirm-btn" onClick={add}>Add Player</button>
        </div>
      </div>
    );
  };

  // ── AUTO-GRADER ───────────────────────────────────────────────────────────
  const AutoGrader=({weekNum})=>{
    const [loading,setLoading]=useState(false);
    const [error,setError]=useState(null);
    const [draft,setDraft]=useState(null);
    const [step,setStep]=useState("idle");
    const weekKey=`w${weekNum}`;
    const weekPicks=state.picks[weekKey]||{};
    const allPicksThisWeek={};
    CATEGORIES.forEach(cat=>{
      const picks=new Set();
      state.users.forEach(u=>{const p=weekPicks[u.id]?.[cat.id];if(p) picks.add(p);});
      allPicksThisWeek[cat.id]=[...picks];
    });
    const runAutoGrade=async()=>{
      setLoading(true);setError(null);setStep("fetching");
      try {
        const scoreboard=await fetchWeekScoreboard(weekNum);
        const events=scoreboard.events||[];
        if(!events.length) throw new Error("No games found for this week.");
        const gameStats=await Promise.all(events.map(e=>fetchGameStats(e.id).catch(()=>null)));
        let mergedPlayerStats={},mergedTeamStats={};
        gameStats.forEach(gs=>{
          if(!gs) return;
          const{playerStats,teamStats}=parsePlayerStats(gs);
          mergedPlayerStats={...mergedPlayerStats,...playerStats};
          mergedTeamStats={...mergedTeamStats,...teamStats};
        });
        const gradingDraft={};
        CATEGORIES.forEach(cat=>{
          gradingDraft[cat.id]={};
          allPicksThisWeek[cat.id].forEach(pickName=>{
            if(cat.type==="team"){
              const teamEntry=Object.entries(mergedTeamStats).find(([abbr])=>{
                const score=fuzzyMatch(pickName,abbr);
                if(score>0.8) return true;
                const team=teams.find(t=>t.abbr===abbr);
                return team&&(fuzzyMatch(pickName,team.name)>0.75||fuzzyMatch(pickName,team.short)>0.75);
              });
              if(teamEntry){
                const[abbr,stats]=teamEntry;
                gradingDraft[cat.id][pickName]={passed:cat.gradeWithThreshold(stats),stats,matchedName:abbr,confidence:1,flagged:false};
              } else {
                gradingDraft[cat.id][pickName]={passed:false,stats:null,matchedName:null,confidence:0,flagged:true,flagReason:"Team not found in ESPN data"};
              }
            } else {
              const matches=Object.entries(mergedPlayerStats).map(([espnName,stats])=>({espnName,stats,score:fuzzyMatch(pickName,espnName)})).filter(m=>m.score>0.6).sort((a,b)=>b.score-a.score);
              if(matches.length&&matches[0].score>=0.85){
                const best=matches[0];
                gradingDraft[cat.id][pickName]={passed:cat.gradeWithThreshold(best.stats),stats:best.stats,matchedName:best.espnName,confidence:best.score,flagged:false};
              } else if(matches.length&&matches[0].score>=0.6){
                const best=matches[0];
                gradingDraft[cat.id][pickName]={passed:cat.gradeWithThreshold(best.stats),stats:best.stats,matchedName:best.espnName,confidence:best.score,flagged:true,flagReason:`Low-confidence match: "${best.espnName}" (${Math.round(best.score*100)}%)`};
              } else {
                gradingDraft[cat.id][pickName]={passed:false,stats:null,matchedName:null,confidence:0,flagged:true,flagReason:"Player not found in ESPN stats"};
              }
            }
          });
        });
        setDraft(gradingDraft);setStep("review");
      } catch(e){setError(e.message||"Failed to fetch ESPN data.");setStep("idle");}
      finally{setLoading(false);}
    };
    const toggleOverride=(catId,pickName)=>{
      setDraft(prev=>{const entry=prev[catId][pickName];return{...prev,[catId]:{...prev[catId],[pickName]:{...entry,passed:!entry.passed,overridden:true}}};});
    };
    const approveDraft=()=>{applyApprovedGrades(weekNum,draft);setStep("approved");};
    const flaggedCount=draft?Object.values(draft).flatMap(Object.values).filter(v=>v.flagged).length:0;
    const statSummary=(catId,stats)=>{
      if(!stats) return "No data";
      switch(catId){
        case "rb": return `Rush:${stats.rushingYards||0}y Rec:${stats.receivingYards||0}y Total:${(stats.rushingYards||0)+(stats.receivingYards||0)}y`;
        case "passing": return `Pass:${stats.passingYards||0}y`;
        case "receiving": return `Rec:${stats.receivingYards||0}y`;
        case "tfl": return `TFL:${stats.tacklesForLoss||0} Sacks:${stats.sacks||0} FF:${stats.forcedFumbles||0} INT:${stats.interceptions||0} QBH:${stats.qbHits||0}`;
        case "defense": return `Allowed:${stats.opponentScore??'?'}pts`;
        case "offense": return `Scored:${stats.teamScore??'?'}pts`;
        case "td": return `TDs:${stats.touchdowns||0} 2PT:${stats.twoPointConversions||0} LngRush:${stats.longRush||0}y LngRec:${stats.longReception||0}y`;
        case "kicker": return `FG:${stats.fieldGoalsMade||0} XPM:${stats.extraPointsMade||0} XP-Miss:${stats.extraPointsMissed||0}`;
        case "win":case "loss": return `Score:${stats.teamScore??'?'}-${stats.opponentScore??'?'} (${stats.won?"W":"L"})`;
        default: return "";
      }
    };
    if(step==="approved") return(
      <div style={{textAlign:"center",padding:"40px 20px"}}>
        <div style={{fontSize:48,marginBottom:12}}>✅</div>
        <p style={{fontWeight:600,fontSize:16,marginBottom:6}}>Week {weekNum} graded &amp; published!</p>
        <p style={{color:"var(--muted)",fontSize:13,marginBottom:20}}>Made a mistake? You can re-grade to correct it.</p>
        <button style={{background:"var(--surface2)",border:"1px solid var(--border)",color:"var(--text)",padding:"10px 20px",borderRadius:8,cursor:"pointer",fontSize:13}} onClick={()=>{setDraft(null);setStep("idle");}}>
          ↩ Re-grade Week {weekNum}
        </button>
      </div>
    );
    return(
      <div>
        {step==="idle"&&<div>
          <p style={{color:"var(--muted)",fontSize:13,marginBottom:14}}>Pull live stats from ESPN and auto-grade every pick. You'll review before anything is saved.</p>
          <button className="espn-btn" onClick={runAutoGrade} disabled={loading}>{loading?"⏳ Fetching…":"⚡ Auto-Grade Week "+weekNum+" from ESPN"}</button>
          {error&&<div className="grade-error">⚠️ {error}</div>}
        </div>}
        {step==="fetching"&&<div style={{textAlign:"center",padding:"40px 20px"}}>
          <div className="spinner"/>
          <p>Fetching ESPN stats for Week {weekNum}…</p>
          <p style={{color:"var(--muted)",fontSize:13,marginTop:6}}>Pulling all game data &amp; matching picks</p>
        </div>}
        {step==="review"&&draft&&<div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,gap:10}}>
            <div>
              <h3 className="section-title">Review Grades — Week {weekNum}</h3>
              <p style={{color:"var(--muted)",fontSize:13}}>{flaggedCount>0?`⚠️ ${flaggedCount} picks need review`:"✅ All picks matched"}</p>
            </div>
            <button className="approve-btn" onClick={approveDraft}>Approve &amp; Publish</button>
          </div>
          {CATEGORIES.map(cat=>{
            const catDraft=draft[cat.id]||{};
            if(!Object.keys(catDraft).length) return null;
            return(<div key={cat.id} className="grade-cat-block">
              <div className="grade-cat-title">{cat.icon} {cat.name} <span className="grade-threshold">{cat.description}</span></div>
              {Object.entries(catDraft).map(([pickName,g])=>(
                <div key={pickName} className={`grade-row ${g.flagged?"flagged":""} ${g.passed?"pass":"fail"}`}>
                  <div className="grade-row-left">
                    <div className="grade-pick-name">
                      {pickName}
                      {g.matchedName&&g.matchedName!==pickName&&<span className="matched-as"> → {g.matchedName}</span>}
                      {g.confidence<1&&g.confidence>0&&<span className="conf-badge">{Math.round(g.confidence*100)}%</span>}
                    </div>
                    <div className="grade-stats">{statSummary(cat.id,g.stats)}</div>
                    {g.flagged&&<div className="flag-reason">⚠️ {g.flagReason}</div>}
                    {g.overridden&&<div className="override-label">✏️ Manually overridden</div>}
                  </div>
                  <div className="grade-row-right">
                    <div className={`grade-result ${g.passed?"pass":"fail"}`}>{g.passed?"✅ PASS":"❌ FAIL"}</div>
                    <button className="override-btn" onClick={()=>toggleOverride(cat.id,pickName)}>Override → {g.passed?"FAIL":"PASS"}</button>
                  </div>
                </div>
              ))}
            </div>);
          })}
          <div style={{display:"flex",gap:10,marginTop:16}}>
            <button className="approve-btn" onClick={approveDraft}>✅ Approve &amp; Publish</button>
            <button className="rerun-btn" onClick={()=>{setDraft(null);setStep("idle");}}>↩ Re-run</button>
          </div>
        </div>}
      </div>
    );
  };

  // ── VIEWS ─────────────────────────────────────────────────────────────────
  const LoginView=()=>{
    const [un,setUn]=useState("");const [pw,setPw]=useState("");
    return(<div className="auth-wrap"><div className="auth-box">
      <div className="auth-logo">LAST<br/>STAND</div>
      <p className="auth-sub">NFL Survivor Fantasy</p>
      <div className="auth-fields">
        <input className="auth-input" placeholder="Username" value={un} onChange={e=>setUn(e.target.value)} autoCapitalize="off"/>
        <input className="auth-input" type="password" placeholder="Password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&login(un,pw)}/>
        <button className="auth-btn primary" onClick={()=>login(un,pw)}>Sign In</button>
        <button className="auth-btn ghost" onClick={()=>setView("register")}>Create Account</button>
      </div>
      <button className="admin-login-link" onClick={()=>setView("admin")}>⚙️ Admin Access</button>
    </div></div>);
  };

  const RegisterView=()=>{
    const [un,setUn]=useState("");const [pw,setPw]=useState("");const [tn,setTn]=useState("");const [pw2,setPw2]=useState("");
    const submit=()=>{if(pw!==pw2){notify("Passwords don't match","error");return;}if(pw.length<4){notify("Password must be 4+ chars","error");return;}register(un,pw,tn);};
    return(<div className="auth-wrap"><div className="auth-box">
      <button className="back-btn-text" onClick={()=>setView("login")}>← Back</button>
      <div className="auth-logo small">LAST STAND</div>
      <p className="auth-sub">Create your account</p>
      <div className="auth-fields">
        <input className="auth-input" placeholder="Username" value={un} onChange={e=>setUn(e.target.value)} autoCapitalize="off"/>
        <input className="auth-input" placeholder="Team Name" value={tn} onChange={e=>setTn(e.target.value)}/>
        <input className="auth-input" type="password" placeholder="Password" value={pw} onChange={e=>setPw(e.target.value)}/>
        <input className="auth-input" type="password" placeholder="Confirm Password" value={pw2} onChange={e=>setPw2(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/>
        <button className="auth-btn primary" onClick={submit}>Create Account</button>
      </div>
    </div></div>);
  };

  const HomeView=()=>{
    const standings=getStandings();
    const currentUser=state.users.find(u=>u.id===loggedInUser?.id);
    const myRank=currentUser ? standings.findIndex(u=>u.id===currentUser.id)+1 : 0;
    const myStats=currentUser ? standings.find(u=>u.id===currentUser.id) : null;
    const totalCats=CATEGORIES.length;
    const weekKey=`w${state.currentWeek}`;
    const picksDue=currentUser ? CATEGORIES.filter(c=>!isEliminated(currentUser.id,c.id)&&!state.picks[weekKey]?.[currentUser.id]?.[c.id]).length : 0;
    const medalFor=(i)=>i===0?"🥇":i===1?"🥈":i===2?"🥉":null;
    return(<div>
      <div className="home-header">
        <div><div className="home-week-pill">WEEK {state.currentWeek}</div><h1 className="home-title">LAST STAND</h1></div>
        <div>{rosterLoading&&<span className="badge loading">⏳ Rosters…</span>}{rosterLoaded&&<span className="badge ready">✅ Live</span>}{rosterError&&<span className="badge berror">⚠️ Error</span>}</div>
      </div>
      <div className="my-status-card">
        <div className="my-status-left"><Avatar user={loggedInUser} size={48}/><div><div className="my-status-team">{loggedInUser.teamName}</div><div className="my-status-rank">{currentUser ? `#${myRank} of ${standings.length}` : "Admin"}</div></div></div>
        <div className="my-status-right">
          <div className="my-status-stat"><span className="my-status-num" style={{color:"var(--success)"}}>{myStats?.alive??totalCats}</span><span className="my-status-label">alive</span></div>
          <div className="my-status-divider"/>
          <div className="my-status-stat"><span className="my-status-num" style={{color:picksDue>0?"var(--warn)":"var(--muted)"}}>{picksDue}</span><span className="my-status-label">picks due</span></div>
        </div>
      </div>
      {picksDue>0&&<button className="picks-nudge" onClick={()=>setView("picks")}>📋 You have {picksDue} pick{picksDue>1?"s":""} due for Week {state.currentWeek} →</button>}
      <div className="lb-section">
        <div className="lb-header"><span className="lb-title">🏆 Leaderboard</span><span className="lb-sub">{standings.length} teams · {totalCats} categories</span></div>
        {!standings.length&&<div className="lb-empty">No players yet</div>}
        {standings.map((u,i)=>{
          const isMe=u.id===currentUser?.id;
          const pct=Math.round((u.alive/totalCats)*100);
          const medal=medalFor(i);
          return(<div key={u.id} className={`lb-row ${isMe?"lb-me":""} ${i===0?"lb-first":""}`}>
            <div className="lb-rank">{medal?<span className="lb-medal">{medal}</span>:<span className="lb-rank-num">#{i+1}</span>}</div>
            <Avatar user={u} size={38}/>
            <div className="lb-info">
              <div className="lb-name">{u.teamName}{isMe&&<span className="lb-you-tag">YOU</span>}</div>
              <div className="lb-bar-wrap"><div className="lb-bar" style={{width:`${pct}%`,background:u.avatarColor||"var(--accent)"}}/></div>
            </div>
            <div className="lb-counts"><span className="lb-alive">{u.alive}<span className="lb-alive-label">/{totalCats}</span></span>{u.elim>0&&<span className="lb-elim">−{u.elim}</span>}</div>
          </div>);
        })}
      </div>
      <div className="nav-grid" style={{marginTop:16}}>
        {[{v:"picks",icon:"📋",label:"Make Picks",desc:"Submit weekly selections"},{v:"standings",icon:"🏆",label:"Standings",desc:"Full breakdown"},{v:"categories",icon:"📊",label:"Categories",desc:"Who's alive"}].map(n=>(
          <button key={n.v} className="nav-card" onClick={()=>setView(n.v)}>
            <span className="nav-icon">{n.icon}</span><span className="nav-label">{n.label}</span><span className="nav-desc">{n.desc}</span>
          </button>
        ))}
      </div>
    </div>);
  };

  const PicksView=()=>{
    const [pickerCat,setPickerCat]=useState(null);
    const [pickInput,setPickInput]=useState("");
    const [suggestions,setSuggestions]=useState([]);
    const [noResults,setNoResults]=useState(false);
    const inputRef=useRef(null);
    const weekKey=`w${state.currentWeek}`;

    // Safety check — make sure logged in user exists in the player list
    const currentUser=state.users.find(u=>u.id===loggedInUser?.id);
    if(!currentUser){
      return(
        <div>
          <h2 className="view-title">My Picks <span className="week-badge">Week {state.currentWeek}</span></h2>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--radius)",padding:30,textAlign:"center"}}>
            <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
            <p style={{fontWeight:600,marginBottom:8}}>Your account isn't in the player list</p>
            <p style={{color:"var(--muted)",fontSize:13}}>Ask the admin to add you as a player in the Admin → Users tab, then log back in.</p>
          </div>
        </div>
      );
    }
    const uid=currentUser.id;

    const handleInput=val=>{
      setPickInput(val);setNoResults(false);
      if(!val||val.length<2){setSuggestions([]);return;}
      const usedPicks=getUsedPicks(uid,pickerCat?.id);
      let results=[];
      if(pickerCat?.type==="team"){
        results=searchTeams(val).filter(t=>!usedPicks.includes(t.name)).map(t=>({
          label:t.name, sub:t.abbr, key:t.name,
          locked:isTeamGameStarted(t.name),
        }));
      } else {
        results=searchPlayers(val,pickerCat?.positions||[]).filter(p=>!usedPicks.includes(p.name)).map(p=>({
          label:p.name, sub:`${p.pos} · ${p.teamAbbr}`, key:p.name,
          locked:isPlayerGameStarted(p.name),
          teamAbbr:p.teamAbbr,
        }));
      }
      setSuggestions(results);setNoResults(results.length===0);
    };

    const openPicker=cat=>{setPickerCat(cat);setPickInput("");setSuggestions([]);setNoResults(false);setTimeout(()=>inputRef.current?.focus(),80);};
    const confirmPick=key=>{makePick(uid,pickerCat.id,key);setPickerCat(null);setPickInput("");setSuggestions([]);setNoResults(false);};
    const closePicker=()=>{setPickerCat(null);setPickInput("");setSuggestions([]);setNoResults(false);};

    return(<div>
      <h2 className="view-title">My Picks <span className="week-badge">Week {state.currentWeek}</span></h2>
      {!rosterLoaded&&<div className="roster-warn">{rosterLoading?"⏳ Loading live rosters…":rosterError||""}</div>}
      <div className="categories-list">
        {CATEGORIES.map(cat=>{
          const elim=isEliminated(uid,cat.id);
          const currentPick=state.picks[weekKey]?.[uid]?.[cat.id];
          const usedPicks=getUsedPicks(uid,cat.id);
          const pickLocked=currentPick&&(cat.type==="team"?isTeamGameStarted(currentPick):isPlayerGameStarted(currentPick));
          return(<div key={cat.id} className={`cat-row ${elim?"eliminated":""} ${currentPick?"picked":""}`}>
            <div className="cat-info">
              <span className="cat-icon">{cat.icon}</span>
              <div>
                <div className="cat-name">{cat.name}</div>
                <div className="cat-desc">{cat.description}</div>
                {usedPicks.length>0&&<div className="used-picks">Used: {usedPicks.join(", ")}</div>}
              </div>
            </div>
            <div className="cat-action">
              {elim?<span className="elim-badge">OUT</span>
                :currentPick?(<div className="pick-display">
                  <span className="pick-name">✓ {currentPick}</span>
                  {pickLocked
                    ?<span className="locked-pick-badge">🔒 Game Started</span>
                    :<button className="change-btn" onClick={()=>openPicker(cat)}>Change</button>}
                </div>)
                :(<button className="pick-btn" onClick={()=>openPicker(cat)}>Pick {cat.type==="team"?"Team":"Player"}</button>)}
            </div>
          </div>);
        })}
      </div>

      {pickerCat&&(<div className="modal-overlay" onClick={closePicker}>
        <div className="modal picker-modal" onClick={e=>e.stopPropagation()}>
          <div className="picker-modal-header">
            <div><h3>{pickerCat.icon} {pickerCat.name}</h3><p className="modal-desc">{pickerCat.description}</p></div>
            <button className="picker-close-btn" onClick={closePicker}>✕</button>
          </div>
          {getUsedPicks(uid,pickerCat.id).length>0&&<div className="used-in-modal"><strong>Already used:</strong> {getUsedPicks(uid,pickerCat.id).join(", ")}</div>}
          <div className="picker-search-wrap">
            <span className="picker-search-icon">🔍</span>
            <input ref={inputRef} className="picker-search-input" placeholder={pickerCat.type==="team"?"Search NFL team…":"Search player…"} value={pickInput} onChange={e=>handleInput(e.target.value)}/>
            {pickInput&&<button className="picker-clear-btn" onClick={()=>{setPickInput("");setSuggestions([]);setNoResults(false);inputRef.current?.focus();}}>✕</button>}
          </div>
          <div className="picker-list">
            {!pickInput&&<div className="picker-prompt">Start typing to search {pickerCat.type==="team"?"an NFL team":"a player"}</div>}
            {pickInput.length===1&&<div className="picker-prompt">Keep typing…</div>}
            {suggestions.map(s=>(
              s.locked
                ?<div key={s.key} className="picker-list-item picker-list-item-locked">
                  <div className="picker-item-left">
                    <span className="picker-item-name" style={{opacity:.5}}>{s.label}</span>
                    <span className="picker-item-sub">{s.sub}</span>
                  </div>
                  <span className="game-started-badge">🔒 Game Started</span>
                </div>
                :<button key={s.key} className="picker-list-item" onClick={()=>confirmPick(s.key)}>
                  <div className="picker-item-left">
                    <span className="picker-item-name">{s.label}</span>
                    <span className="picker-item-sub">{s.sub}</span>
                  </div>
                  <span className="picker-item-arrow">→</span>
                </button>
            ))}
            {noResults&&pickInput.length>=2&&<div className="picker-no-results">
              <span style={{fontSize:32,display:"block",marginBottom:10}}>🔎</span>
              <p style={{fontSize:13,marginBottom:4}}>No results for "<strong>{pickInput}</strong>"</p>
              <p style={{fontSize:11,color:"var(--muted)"}}>Try last name only or different spelling</p>
            </div>}
          </div>
          <button className="cancel-btn" onClick={closePicker}>Cancel</button>
        </div>
      </div>)}
    </div>);
  };

  const StandingsView=()=>{
    const standings=getStandings();const weekKey=`w${state.currentWeek}`;const locked=isWeekLocked(state.currentWeek);
    const grading=state.gradingResults?.[weekKey];
    return(<div>
      <h2 className="view-title">Standings</h2>
      {!locked&&<div className="locked-notice">🔒 Picks hidden until admin publishes results</div>}
      <div className="standings-list">
        {standings.map((u,i)=>(<div key={u.id} className={`standing-row ${i===0?"rank-1":""}`}>
          <div className="rank-num">{i===0?"🥇":`#${i+1}`}</div>
          <Avatar user={u} size={42}/>
          <div className="standing-info">
            <div className="standing-name">{u.teamName}</div>
            <div className="standing-username">@{u.username}</div>
            <div className="standing-bar-wrap"><div className="standing-bar" style={{width:`${(u.alive/CATEGORIES.length)*100}%`}}/></div>
          </div>
          <div className="standing-counts"><span className="alive-count">{u.alive} alive</span><span className="elim-count">{u.elim} out</span></div>
        </div>))}
        {!standings.length&&<p className="empty-msg">No players yet!</p>}
      </div>
      {locked&&grading&&(<div style={{marginTop:28}}>
        <h3 className="section-title" style={{marginBottom:14}}>Week {state.currentWeek} Results</h3>
        {CATEGORIES.map(cat=>{
          const catGrades=grading[cat.id]||{};const successPicks=state.results[weekKey]?.[cat.id]||[];
          return(<div key={cat.id} className="result-reveal-row">
            <div className="result-cat">{cat.icon} {cat.name}</div>
            <div className="reveal-picks">
              {state.users.map(u=>{
                const pick=state.picks[weekKey]?.[u.id]?.[cat.id];
                const hit=pick&&successPicks.includes(pick);
                const miss=pick&&!successPicks.includes(pick)&&successPicks.length>0;
                const elim=isEliminated(u.id,cat.id);
                return(<div key={u.id} className={`reveal-pick-item ${hit?"hit":miss?"miss":elim?"elim-item":""}`}>
                  <Avatar user={u} size={24}/>
                  <div className="reveal-pick-info"><span className="reveal-team">{u.teamName}</span><span className="reveal-pick">{pick||<em>No pick</em>}</span></div>
                  <span className="reveal-status">{hit?"✅":miss?"❌":elim?"💀":"⏳"}</span>
                </div>);
              })}
            </div>
          </div>);
        })}
      </div>)}
    </div>);
  };

  const CategoriesView=()=>(<div>
    <h2 className="view-title">Categories</h2>
    <div className="cat-grid">
      {CATEGORIES.map(cat=>{
        const survivors=state.users.filter(u=>!isEliminated(u.id,cat.id));
        return(<div key={cat.id} className="cat-card">
          <div className="cat-card-header"><span className="cat-card-icon">{cat.icon}</span><div><div className="cat-card-name">{cat.name}</div><div className="cat-card-desc">{cat.description}</div></div></div>
          <div className="cat-survivors"><span className="survivor-count">{survivors.length}</span><span className="survivor-label"> alive</span></div>
          <div className="survivor-names">
            {survivors.slice(0,5).map(u=><span key={u.id} className="survivor-tag" style={{borderLeft:`3px solid ${u.avatarColor}`}}>{u.teamName}</span>)}
            {survivors.length>5&&<span className="survivor-tag more">+{survivors.length-5}</span>}
            {!survivors.length&&<span className="no-survivors">Category over!</span>}
          </div>
        </div>);
      })}
    </div>
  </div>);

  const AdminView=()=>{
    const [pw,setPw]=useState("");

    const weekKey=`w${state.currentWeek}`;
    if(!adminAuthed) return(<div className="admin-login">
      <div className="lock-icon">🔒</div><h2>Admin Access</h2><p style={{color:"var(--muted)"}}>Enter admin password</p>
      <input type="password" className="admin-pw-input" placeholder="Password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){if(pw===ADMIN_PASSWORD)setAdminAuthed(true);else notify("Wrong password","error");}}}/>
      <button className="confirm-btn" onClick={()=>{if(pw===ADMIN_PASSWORD)setAdminAuthed(true);else notify("Wrong password","error");}}>Login</button>
    </div>);
    const adminCreateUser=async()=>{
      if(!adminNewUn.trim()||!adminNewPw.trim()||!adminNewTn.trim()){notify("All fields required","error");return;}
      if(state.users.find(u=>u.username.toLowerCase()===adminNewUn.toLowerCase())){notify("Username taken","error");return;}
      const color=AVATAR_COLORS[state.users.length%AVATAR_COLORS.length];
      const newUser={id:Date.now().toString(),username:adminNewUn.trim(),passwordHash:hashPassword(adminNewPw.trim()),teamName:adminNewTn.trim(),avatarColor:color};
      const newState={...state,users:[...state.users,newUser]};
      setState(newState);
      // Force immediate save so user can log in right away
      await saveLeagueState(newState);
      setAdminNewUn("");setAdminNewPw("");setAdminNewTn("");
      notify(`${adminNewTn} added! They can now log in.`);
    };

    const adminResetPassword=(userId, newPassword)=>{
      if(!newPassword.trim()||newPassword.trim().length<4){notify("Password must be 4+ characters","error");return;}
      setState(s=>({...s,users:s.users.map(u=>u.id===userId?{...u,passwordHash:hashPassword(newPassword.trim())}:u)}));
      notify("Password reset successfully!");
    };
    const setResultManual=(weekNum,categoryId,successfulPicks)=>{
      const wk=`w${weekNum}`;const weekPicks=state.picks[wk]||{};
      const newElims=JSON.parse(JSON.stringify(state.eliminations||{}));
      state.users.forEach(user=>{
        if(isEliminated(user.id,categoryId)) return;
        const pick=weekPicks[user.id]?.[categoryId];
        if(!pick||!successfulPicks.includes(pick)){if(!newElims[user.id])newElims[user.id]={};newElims[user.id][categoryId]=true;}
      });
      setState(s=>({...s,eliminations:newElims,results:{...s.results,[wk]:{...(s.results[wk]||{}),[categoryId]:successfulPicks}}}));
      notify("Results saved!");
    };
    return(<div>
      <h2 className="view-title">Admin Panel</h2>
      <div className="admin-tabs">
        {["grade","picks","results","roster","settings","users","week"].map(t=>(
          <button key={t} className={`admin-tab ${adminTab===t?"active":""}`} onClick={()=>setAdminTab(t)}>
            {t==="grade"?"⚡ Grade":t==="picks"?"👁 Picks":t==="results"?"📋 Results":t==="roster"?"🏈 Roster":t==="settings"?"⚙️ Rules":t==="users"?"👥 Users":"📅 Week"}
          </button>
        ))}
      </div>
      {adminTab==="grade"&&<div><h3 className="section-title">ESPN Auto-Grader</h3><AutoGrader weekNum={state.currentWeek}/></div>}
      {adminTab==="picks"&&<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <h3 className="section-title">Week {state.currentWeek} Picks Overview</h3>
          <span style={{fontSize:12,color:"var(--muted)"}}>{state.users.length} players</span>
        </div>
        <p style={{color:"var(--muted)",fontSize:13,marginBottom:14}}>See all picks at a glance. Missing picks shown with —</p>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr>
                <th style={{textAlign:"left",padding:"8px 10px",background:"var(--surface2)",borderBottom:"2px solid var(--border)",fontWeight:700,position:"sticky",left:0,zIndex:2,minWidth:100}}>Player</th>
                {CATEGORIES.map(cat=>(
                  <th key={cat.id} style={{padding:"6px 8px",background:"var(--surface2)",borderBottom:"2px solid var(--border)",textAlign:"center",minWidth:80,fontWeight:600}}>
                    {cat.icon}<br/><span style={{fontSize:10,color:"var(--muted)",fontWeight:400}}>{cat.name.split("/")[0].trim()}</span>
                  </th>
                ))}
                <th style={{padding:"6px 8px",background:"var(--surface2)",borderBottom:"2px solid var(--border)",textAlign:"center",minWidth:80,fontWeight:600}}>Status</th>
              </tr>
            </thead>
            <tbody>
              {state.users.map((u,i)=>{
                const weekKey=`w${state.currentWeek}`;
                const userPicks=state.picks[weekKey]?.[u.id]||{};
                const aliveCats=CATEGORIES.filter(c=>!isEliminated(u.id,c.id));
                const missingCount=aliveCats.filter(c=>!userPicks[c.id]).length;
                return(
                  <tr key={u.id} style={{background:i%2===0?"var(--surface)":"var(--surface2)"}}>
                    <td style={{padding:"8px 10px",fontWeight:600,borderBottom:"1px solid var(--border)",position:"sticky",left:0,background:i%2===0?"var(--surface)":"var(--surface2)",zIndex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{width:22,height:22,borderRadius:"50%",background:u.avatarColor||"var(--accent)",color:"#000",fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,flexShrink:0}}>{u.teamName?.[0]}</div>
                        <span style={{fontSize:11}}>{u.teamName}</span>
                      </div>
                    </td>
                    {CATEGORIES.map(cat=>{
                      const elim=isEliminated(u.id,cat.id);
                      const pick=userPicks[cat.id];
                      return(
                        <td key={cat.id} style={{padding:"6px 8px",textAlign:"center",borderBottom:"1px solid var(--border)",borderLeft:"1px solid var(--border)"}}>
                          {elim
                            ?<span style={{color:"var(--accent2)",fontSize:11}}>💀</span>
                            :pick
                              ?<span style={{color:"var(--success)",fontSize:10,display:"block",maxWidth:80,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={pick}>✓ {pick}</span>
                              :<span style={{color:"var(--accent2)",fontWeight:700,fontSize:14}}>—</span>
                          }
                        </td>
                      );
                    })}
                    <td style={{padding:"6px 8px",textAlign:"center",borderBottom:"1px solid var(--border)",borderLeft:"1px solid var(--border)"}}>
                      {missingCount===0
                        ?<span style={{color:"var(--success)",fontSize:11,fontWeight:700}}>✅ Done</span>
                        :<span style={{color:"var(--accent2)",fontSize:11,fontWeight:700}}>⚠️ {missingCount} left</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {state.users.length===0&&<p className="empty-msg">No players yet</p>}
        <div style={{marginTop:14,padding:"10px 14px",background:"var(--surface2)",borderRadius:8,fontSize:12,color:"var(--muted)"}}>
          ✓ = picked &nbsp;|&nbsp; — = missing &nbsp;|&nbsp; 💀 = eliminated
        </div>
      </div>}
      {adminTab==="results"&&<div>
        <h3 className="section-title">Manual Results — Week {state.currentWeek}</h3>
        <p style={{color:"var(--muted)",fontSize:13,marginBottom:14}}>Check picks that met the threshold this week:</p>
        {CATEGORIES.map(cat=>{
          const allPicks=[...new Set(state.users.map(u=>state.picks[weekKey]?.[u.id]?.[cat.id]).filter(Boolean))];
          return(<div key={cat.id} className="result-row">
            <div className="result-cat">{cat.icon} {cat.name}</div>
            <div className="result-picks">
              {!allPicks.length?<span className="no-picks-msg">No picks made</span>:allPicks.map(pick=>(
                <label key={pick} className="pick-check">
                  <input type="checkbox" checked={adminResultInputs[cat.id]?.includes(pick)||false} onChange={e=>setAdminResultInputs(prev=>{const cur=prev[cat.id]||[];return{...prev,[cat.id]:e.target.checked?[...cur,pick]:cur.filter(p=>p!==pick)};})}/>{pick}
                </label>
              ))}
            </div>
            <button className="save-result-btn" onClick={()=>setResultManual(state.currentWeek,cat.id,adminResultInputs[cat.id]||[])}>Save</button>
          </div>);
        })}
      </div>}
      {adminTab==="roster"&&<div>
        <h3 className="section-title">Custom Players</h3>
        <p style={{color:"var(--muted)",fontSize:13,marginBottom:14}}>Add players not in the built-in roster (new signings, call-ups, etc):</p>
        <AddPlayerForm state={state} setState={setState} notify={notify}/>
        <h3 className="section-title" style={{marginTop:20}}>Custom Players ({(state.customPlayers||[]).length})</h3>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {(state.customPlayers||[]).length===0&&<p style={{color:"var(--muted)",fontSize:13,padding:"10px 0"}}>No custom players added yet</p>}
          {(state.customPlayers||[]).map((p,i)=>(
            <div key={i} style={{background:"var(--surface2)",borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:600,fontSize:14}}>{p.name}</div>
                <div style={{fontSize:11,color:"var(--accent)"}}>{p.pos} · {p.teamAbbr}</div>
              </div>
              <button className="remove-btn" onClick={()=>setState(s=>({...s,customPlayers:s.customPlayers.filter((_,j)=>j!==i)}))}>✕</button>
            </div>
          ))}
        </div>
      </div>}

      {adminTab==="settings"&&<div>
        <h3 className="section-title">Category Rules</h3>
        <p style={{color:"var(--muted)",fontSize:13,marginBottom:14}}>Adjust thresholds for each category:</p>
        <div className="settings-list">
          {CATEGORY_META.map(cat=>{
            const t=state.thresholds?.[cat.id]||DEFAULT_THRESHOLDS[cat.id]||{};
            return(<div key={cat.id} className="settings-cat-card">
              <div className="settings-cat-header"><span className="settings-cat-icon">{cat.icon}</span><div><div className="settings-cat-name">{cat.name}</div><div className="settings-cat-desc">{cat.descFn(t)}</div></div></div>
              {!cat.fields.length&&<div className="settings-fixed-note">No adjustable threshold</div>}
              {cat.fields.map(field=>(<div key={field.key} className="settings-field-row">
                <span className="settings-field-label">{field.label}</span>
                <div className="settings-field-controls">
                  <button className="thresh-btn" onClick={()=>setState(s=>({...s,thresholds:{...s.thresholds,[cat.id]:{...t,[field.key]:Math.max(field.min,(t[field.key]??0)-1)}}}))}>−</button>
                  <input type="number" className="thresh-input" value={t[field.key]??0} min={field.min} max={field.max} onChange={e=>{const val=Math.min(field.max,Math.max(field.min,parseInt(e.target.value)||0));setState(s=>({...s,thresholds:{...s.thresholds,[cat.id]:{...t,[field.key]:val}}}))} }/>
                  <button className="thresh-btn" onClick={()=>setState(s=>({...s,thresholds:{...s.thresholds,[cat.id]:{...t,[field.key]:Math.min(field.max,(t[field.key]??0)+1)}}}))}>+</button>
                </div>
              </div>))}
            </div>);
          })}
        </div>
        <button className="reset-thresholds-btn" onClick={()=>{if(window.confirm("Reset all thresholds to defaults?"))setState(s=>({...s,thresholds:DEFAULT_THRESHOLDS}));}}>↩ Reset to Defaults</button>
      </div>}
      {adminTab==="users"&&<div>
        <h3 className="section-title">Add User</h3>
        <div className="admin-fields">
          <input className="admin-input" placeholder="Username" value={adminNewUn} onChange={e=>setAdminNewUn(e.target.value)} autoCapitalize="off"/>
          <input className="admin-input" placeholder="Team Name" value={adminNewTn} onChange={e=>setAdminNewTn(e.target.value)}/>
          <input className="admin-input" type="password" placeholder="Password" value={adminNewPw} onChange={e=>setAdminNewPw(e.target.value)}/>
          <button className="confirm-btn" onClick={adminCreateUser}>Add User</button>
        </div>
        <h3 className="section-title" style={{marginTop:20}}>All Users ({state.users.length})</h3>
        <div className="player-list-admin">
          {state.users.map(u=>(
            <UserAdminRow key={u.id} user={u} onReset={adminResetPassword} onRemove={()=>setState(s=>({...s,users:s.users.filter(x=>x.id!==u.id)}))} Avatar={Avatar}/>
          ))}
          {!state.users.length&&<p className="empty-msg">No users yet</p>}
        </div>
      </div>}
      {adminTab==="week"&&<div>
        <h3 className="section-title">Week Management</h3>
        <div className="week-controls">
          <button className="week-btn" onClick={()=>setState(s=>({...s,currentWeek:Math.max(1,s.currentWeek-1)}))}>← Prev</button>
          <span className="week-display">Week {state.currentWeek}</span>
          <button className="week-btn" onClick={()=>setState(s=>({...s,currentWeek:s.currentWeek+1}))}>Next →</button>
        </div>
        <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--radius)",padding:16,marginTop:16}}>
          <h4 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,marginBottom:6}}>🔒 Pick Lock — Week {state.currentWeek}</h4>
          <p style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>Lock picks manually when games start. Use this if the automatic kickoff lock isn't working.</p>
          {isWeekLocked(state.currentWeek)
            ?<div>
              <div style={{background:"rgba(60,255,138,.1)",border:"1px solid var(--success)",borderRadius:8,padding:"10px 14px",fontSize:13,color:"var(--success)",marginBottom:10}}>✅ Week {state.currentWeek} picks are LOCKED</div>
              <button style={{background:"none",border:"1px solid var(--accent2)",color:"var(--accent2)",padding:"10px 18px",borderRadius:8,cursor:"pointer",fontSize:13,width:"100%"}}
                onClick={()=>{if(window.confirm("Unlock picks for Week "+state.currentWeek+"?"))setState(s=>({...s,weekLocked:{...s.weekLocked,[`w${state.currentWeek}`]:false}}))}}>
                🔓 Unlock Week {state.currentWeek} Picks
              </button>
            </div>
            :<button style={{background:"var(--accent)",color:"#000",border:"none",padding:12,borderRadius:8,cursor:"pointer",fontWeight:700,fontSize:14,width:"100%"}}
              onClick={()=>{if(window.confirm("Lock all picks for Week "+state.currentWeek+"? Players cannot change picks after this."))setState(s=>({...s,weekLocked:{...s.weekLocked,[`w${state.currentWeek}`]:true}}))}}>
              🔒 Lock All Week {state.currentWeek} Picks Now
            </button>
          }
        </div>
        <div className="danger-zone">
          <h4>⚠️ Danger Zone</h4>
          <button className="danger-btn" onClick={()=>{if(window.confirm("Reset ALL data? Cannot be undone."))setState(initialState);}}>Reset All Data</button>
        </div>
      </div>}
    </div>);
  };

  const SafeView=({component:Component})=>{
    try { return <Component/>; }
    catch(e) {
      console.error("View crashed:",e);
      return(
        <div style={{padding:30,textAlign:"center"}}>
          <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
          <p style={{fontWeight:600,marginBottom:8}}>Something went wrong</p>
          <p style={{color:"var(--muted)",fontSize:13,marginBottom:16}}>Try going back to Home and trying again.</p>
          <button style={{background:"var(--accent)",color:"#000",border:"none",padding:"10px 20px",borderRadius:8,cursor:"pointer",fontWeight:700}} onClick={()=>setView("home")}>← Go Home</button>
        </div>
      );
    }
  };
  const VIEWS={home:<SafeView component={HomeView}/>,picks:<SafeView component={PicksView}/>,standings:<SafeView component={StandingsView}/>,categories:<SafeView component={CategoriesView}/>,admin:<SafeView component={AdminView}/>};
  const AUTH_VIEWS={login:<LoginView/>,register:<RegisterView/>};
  const isAuth=view==="login"||view==="register";

  if(dbLoading) return(
    <div style={{minHeight:"100vh",background:"#0a0a0f",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,color:"#f0f0f8"}}>
      <div style={{width:40,height:40,border:"3px solid rgba(255,255,255,.1)",borderTopColor:"#e8ff3c",borderRadius:"50%",animation:"spin .8s linear infinite"}}/>
      <p style={{color:"#6b6b80",fontSize:14}}>Connecting to league…</p>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if(dbError) return(
    <div style={{minHeight:"100vh",background:"#0a0a0f",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,color:"#f0f0f8",padding:20,textAlign:"center"}}>
      <div style={{fontSize:48}}>⚠️</div>
      <h2 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:32}}>Connection Error</h2>
      <p style={{color:"#6b6b80",fontSize:14}}>{dbError}</p>
      <p style={{color:"#6b6b80",fontSize:12}}>Check your Supabase environment variables in Vercel.</p>
    </div>
  );

  return(
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        :root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--border:rgba(255,255,255,0.08);--accent:#e8ff3c;--accent2:#ff4d4d;--text:#f0f0f8;--muted:#6b6b80;--success:#3cff8a;--warn:#ffb347;--radius:12px}
        body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif}
        .app{min-height:100vh;background:var(--bg);background-image:radial-gradient(ellipse at 20% 0%,rgba(232,255,60,.05) 0%,transparent 60%),radial-gradient(ellipse at 80% 100%,rgba(255,77,77,.05) 0%,transparent 60%);display:flex;flex-direction:column}
        @keyframes spin{to{transform:rotate(360deg)}}
        .topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--border);background:rgba(10,10,15,.9);backdrop-filter:blur(12px);position:sticky;top:0;z-index:100}
        .topbar-logo{font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;color:var(--accent);cursor:pointer}
        .topbar-right{display:flex;align-items:center;gap:10px}
        .topbar-user{font-size:12px;color:var(--muted)}
        .topbar-user strong{color:var(--text)}
        .logout-btn,.admin-topbar-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:5px 10px;border-radius:8px;cursor:pointer;font-size:12px}
        .logout-btn:hover{border-color:var(--accent2);color:var(--accent2)}
        .admin-topbar-btn:hover{border-color:var(--accent);color:var(--accent)}
        .bottom-nav{position:fixed;bottom:0;left:0;right:0;background:rgba(10,10,15,.95);backdrop-filter:blur(16px);border-top:1px solid var(--border);display:flex;z-index:100;padding-bottom:env(safe-area-inset-bottom)}
        .nav-item{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 0;background:none;border:none;cursor:pointer;color:var(--muted);font-size:10px;font-family:'DM Sans',sans-serif;transition:color .2s}
        .nav-item.active{color:var(--accent)}
        .nav-item-icon{font-size:20px}
        .main-content{flex:1;padding:20px;padding-bottom:90px;max-width:600px;margin:0 auto;width:100%}
        .auth-content{flex:1;display:flex;align-items:center;justify-content:center;padding:20px}
        .auth-wrap{width:100%;display:flex;justify-content:center;padding:40px 20px}
        .auth-box{width:100%;max-width:360px;display:flex;flex-direction:column;gap:16px}
        .auth-logo{font-family:'Bebas Neue',sans-serif;font-size:72px;line-height:.85;letter-spacing:4px;color:var(--text);text-align:center}
        .auth-logo.small{font-size:36px;line-height:1}
        .auth-sub{color:var(--muted);font-size:13px;letter-spacing:2px;text-transform:uppercase;text-align:center}
        .auth-fields{display:flex;flex-direction:column;gap:10px}
        .auth-input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:13px 16px;border-radius:var(--radius);font-size:15px;font-family:'DM Sans',sans-serif;outline:none;width:100%}
        .auth-input:focus{border-color:var(--accent)}
        .auth-btn{padding:13px;border-radius:var(--radius);font-size:15px;font-weight:700;cursor:pointer;border:none;font-family:'DM Sans',sans-serif;width:100%}
        .auth-btn.primary{background:var(--accent);color:#000}
        .auth-btn.ghost{background:none;border:1px solid var(--border);color:var(--text)}
        .back-btn-text{background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;text-align:left}
        .admin-login-link{background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;margin-top:8px;padding:8px;opacity:.5;font-family:'DM Sans',sans-serif;width:100%;text-align:center}
        .admin-login-link:hover{opacity:1}
        .badge{font-size:11px;padding:4px 10px;border-radius:20px;display:inline-block}
        .badge.loading{background:rgba(232,255,60,.1);color:var(--accent)}
        .badge.ready{background:rgba(60,255,138,.1);color:var(--success)}
        .badge.berror{background:rgba(255,77,77,.1);color:var(--accent2)}
        .roster-warn{background:rgba(232,255,60,.08);border:1px solid rgba(232,255,60,.2);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--accent);margin-bottom:14px}
        .home-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
        .home-week-pill{display:inline-block;background:var(--accent);color:#000;font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:3px;padding:3px 12px;border-radius:20px;margin-bottom:4px}
        .home-title{font-family:'Bebas Neue',sans-serif;font-size:38px;letter-spacing:3px;line-height:1}
        .my-status-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
        .my-status-left{display:flex;align-items:center;gap:12px}
        .my-status-team{font-weight:700;font-size:16px}
        .my-status-rank{font-size:12px;color:var(--muted);margin-top:2px}
        .my-status-right{display:flex;align-items:center;gap:12px}
        .my-status-stat{display:flex;flex-direction:column;align-items:center;gap:2px}
        .my-status-num{font-family:'Bebas Neue',sans-serif;font-size:28px;line-height:1}
        .my-status-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
        .my-status-divider{width:1px;height:36px;background:var(--border)}
        .picks-nudge{width:100%;background:rgba(255,179,71,.1);border:1px solid rgba(255,179,71,.4);color:var(--warn);padding:11px 16px;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:600;text-align:left;margin-bottom:16px;font-family:'DM Sans',sans-serif}
        .lb-section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px}
        .lb-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
        .lb-title{font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:1px}
        .lb-sub{font-size:11px;color:var(--muted)}
        .lb-empty{padding:30px;text-align:center;color:var(--muted);font-size:14px}
        .lb-row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
        .lb-row:last-child{border-bottom:none}
        .lb-me{background:rgba(232,255,60,.04)}
        .lb-first{background:rgba(232,255,60,.07)}
        .lb-rank{width:32px;text-align:center;flex-shrink:0}
        .lb-medal{font-size:20px}
        .lb-rank-num{font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--muted)}
        .lb-info{flex:1;min-width:0}
        .lb-name{font-weight:600;font-size:14px;display:flex;align-items:center;gap:7px;margin-bottom:5px}
        .lb-you-tag{background:var(--accent);color:#000;font-size:9px;font-weight:800;padding:1px 6px;border-radius:10px;letter-spacing:1px}
        .lb-bar-wrap{height:3px;background:var(--surface2);border-radius:2px}
        .lb-bar{height:100%;border-radius:2px;transition:width .6s ease}
        .lb-counts{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0}
        .lb-alive{font-family:'Bebas Neue',sans-serif;font-size:22px;line-height:1;color:var(--success)}
        .lb-alive-label{font-size:14px;color:var(--muted)}
        .lb-elim{font-size:11px;color:var(--accent2)}
        .nav-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        .nav-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;display:flex;flex-direction:column;gap:6px;cursor:pointer;text-align:left;transition:all .2s;color:var(--text)}
        .nav-card:hover{border-color:var(--accent);transform:translateY(-2px)}
        .nav-icon{font-size:28px}
        .nav-label{font-weight:600;font-size:15px}
        .nav-desc{font-size:12px;color:var(--muted)}
        .view-title{font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:2px;margin-bottom:20px;display:flex;align-items:center;gap:12px}
        .week-badge{background:var(--accent);color:#000;font-size:14px;padding:3px 10px;border-radius:20px}
        .sub-label{color:var(--muted);font-size:13px;margin-bottom:14px}
        .section-title{font-family:'Bebas Neue',sans-serif;font-size:22px;margin-bottom:8px}
        .empty-msg{color:var(--muted);font-size:14px;text-align:center;padding:30px}
        .locked-notice{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:10px;padding:10px 14px;font-size:12px;color:var(--muted);margin-bottom:16px}
        .categories-list{display:flex;flex-direction:column;gap:8px}
        .cat-row{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
        .cat-row.picked{border-color:rgba(60,255,138,.3)}
        .cat-row.eliminated{opacity:.4}
        .cat-info{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
        .cat-icon{font-size:22px;flex-shrink:0}
        .cat-name{font-weight:600;font-size:13px}
        .cat-desc{font-size:11px;color:var(--muted)}
        .used-picks{font-size:10px;color:var(--muted);margin-top:2px}
        .cat-action{flex-shrink:0}
        .elim-badge{background:var(--accent2);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;letter-spacing:1px}
        .pick-btn{background:var(--accent);color:#000;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600}
        .pick-display{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
        .pick-name{color:var(--success);font-size:12px;font-weight:600}
        .change-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer}
        .locked-pick-badge{font-size:10px;color:var(--warn);background:rgba(255,179,71,.1);border:1px solid rgba(255,179,71,.3);padding:3px 8px;border-radius:6px}
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);backdrop-filter:blur(4px);display:flex;align-items:flex-end;z-index:200}
        .picker-modal{background:var(--surface);border:1px solid var(--border);border-radius:16px 16px 0 0;padding:20px 20px 0;width:100%;max-height:85vh;display:flex;flex-direction:column}
        .picker-modal-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px}
        .picker-modal-header h3{font-family:'Bebas Neue',sans-serif;font-size:24px;margin-bottom:2px}
        .picker-close-btn{background:var(--surface2);border:1px solid var(--border);color:var(--muted);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .modal-desc{color:var(--muted);font-size:13px}
        .used-in-modal{font-size:11px;color:var(--muted);background:var(--surface2);padding:7px 12px;border-radius:8px;margin-bottom:12px}
        .picker-search-wrap{display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:4px}
        .picker-search-wrap:focus-within{border-color:var(--accent)}
        .picker-search-icon{font-size:16px;flex-shrink:0}
        .picker-search-input{flex:1;background:none;border:none;color:var(--text);font-size:15px;font-family:'DM Sans',sans-serif;outline:none}
        .picker-search-input::placeholder{color:var(--muted)}
        .picker-clear-btn{background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;flex-shrink:0}
        .picker-list{flex:1;overflow-y:auto;margin:8px -20px 0;padding:0 8px}
        .picker-prompt{text-align:center;color:var(--muted);font-size:13px;padding:24px 20px}
        .picker-list-item{width:100%;background:none;border:none;border-bottom:1px solid var(--border);color:var(--text);padding:14px 12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;font-family:'DM Sans',sans-serif}
        .picker-list-item:first-of-type{border-top:1px solid var(--border)}
        .picker-list-item:hover{background:rgba(232,255,60,.07)}
        .picker-list-item-locked{width:100%;border-bottom:1px solid var(--border);color:var(--text);padding:14px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;opacity:.55;cursor:not-allowed}
        .picker-list-item-locked:first-of-type{border-top:1px solid var(--border)}
        .picker-item-left{display:flex;flex-direction:column;gap:2px}
        .picker-item-name{font-size:15px;font-weight:600}
        .picker-item-sub{font-size:11px;color:var(--accent);background:rgba(232,255,60,.1);padding:2px 8px;border-radius:10px;width:fit-content}
        .picker-item-arrow{color:var(--muted);font-size:18px;flex-shrink:0}
        .game-started-badge{font-size:11px;color:var(--warn);background:rgba(255,179,71,.1);border:1px solid rgba(255,179,71,.3);padding:3px 8px;border-radius:6px;white-space:nowrap;flex-shrink:0}
        .picker-no-results{text-align:center;padding:24px 20px;color:var(--muted)}
        .cancel-btn{width:100%;background:none;border:none;border-top:1px solid var(--border);color:var(--muted);padding:16px;cursor:pointer;font-size:14px;font-family:'DM Sans',sans-serif;margin-top:4px}
        .standings-list{display:flex;flex-direction:column;gap:10px}
        .standing-row{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;display:flex;align-items:center;gap:12px}
        .rank-1{border-color:rgba(232,255,60,.4);background:rgba(232,255,60,.05)}
        .rank-num{font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--muted);width:36px}
        .rank-1 .rank-num{color:var(--accent)}
        .standing-info{flex:1;min-width:0}
        .standing-name{font-weight:600;font-size:15px}
        .standing-username{font-size:11px;color:var(--muted);margin-bottom:6px}
        .standing-bar-wrap{height:4px;background:var(--surface2);border-radius:2px}
        .standing-bar{height:100%;background:var(--accent);border-radius:2px;transition:width .5s ease}
        .standing-counts{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
        .alive-count{font-size:13px;font-weight:600;color:var(--success)}
        .elim-count{font-size:11px;color:var(--muted)}
        .result-reveal-row{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:8px}
        .result-cat{font-weight:600;font-size:13px;margin-bottom:8px}
        .reveal-picks{display:flex;flex-direction:column;gap:6px}
        .reveal-pick-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--surface2)}
        .reveal-pick-item.hit{background:rgba(60,255,138,.08)}
        .reveal-pick-item.miss{background:rgba(255,77,77,.08)}
        .reveal-pick-item.elim-item{opacity:.5}
        .reveal-pick-info{flex:1;display:flex;flex-direction:column;gap:1px}
        .reveal-team{font-size:12px;font-weight:600}
        .reveal-pick{font-size:11px;color:var(--muted)}
        .reveal-status{font-size:16px}
        .cat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .cat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
        .cat-card-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
        .cat-card-icon{font-size:24px}
        .cat-card-name{font-weight:600;font-size:13px}
        .cat-card-desc{font-size:11px;color:var(--muted)}
        .cat-survivors{margin-bottom:8px}
        .survivor-count{font-family:'Bebas Neue',sans-serif;font-size:32px;color:var(--accent)}
        .survivor-label{font-size:12px;color:var(--muted)}
        .survivor-names{display:flex;flex-wrap:wrap;gap:4px}
        .survivor-tag{background:var(--surface2);font-size:10px;padding:2px 8px;border-radius:10px;color:var(--muted)}
        .survivor-tag.more{background:none;border:1px dashed var(--border)}
        .no-survivors{font-size:12px;color:var(--accent2)}
        .admin-login{display:flex;flex-direction:column;align-items:center;gap:16px;padding:60px 20px;text-align:center}
        .lock-icon{font-size:48px}
        .admin-pw-input{width:100%;max-width:300px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:12px 14px;border-radius:8px;font-size:14px;font-family:'DM Sans',sans-serif;outline:none;text-align:center}
        .confirm-btn{background:var(--accent);color:#000;border:none;padding:12px;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;width:100%;max-width:300px}
        .admin-tabs{display:flex;gap:4px;margin-bottom:20px;flex-wrap:wrap}
        .admin-tab{flex:1;background:var(--surface);border:1px solid var(--border);color:var(--muted);padding:8px 4px;border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap}
        .admin-tab.active{background:var(--accent);color:#000;border-color:var(--accent)}
        .admin-fields{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
        .admin-input{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-size:14px;font-family:'DM Sans',sans-serif;outline:none;width:100%}
        .player-list-admin{display:flex;flex-direction:column;gap:6px}
        .player-admin-row{background:var(--surface2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px}
        .padmin-info{flex:1;display:flex;flex-direction:column}
        .padmin-team{font-size:14px;font-weight:600}
        .padmin-un{font-size:11px;color:var(--muted)}
        .remove-btn{background:none;border:none;color:var(--accent2);cursor:pointer;font-size:16px;padding:0 4px}
        .week-controls{display:flex;align-items:center;gap:14px;margin:16px 0}
        .week-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 18px;border-radius:8px;cursor:pointer;font-size:13px}
        .week-display{font-family:'Bebas Neue',sans-serif;font-size:28px}
        .danger-zone{margin-top:30px;border:1px solid rgba(255,77,77,.3);border-radius:var(--radius);padding:16px}
        .danger-zone h4{color:var(--accent2);margin-bottom:10px;font-size:14px}
        .danger-btn{background:rgba(255,77,77,.15);border:1px solid var(--accent2);color:var(--accent2);padding:10px 18px;border-radius:8px;cursor:pointer;font-size:13px}
        .settings-list{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
        .settings-cat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
        .settings-cat-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
        .settings-cat-icon{font-size:24px;flex-shrink:0}
        .settings-cat-name{font-weight:600;font-size:14px}
        .settings-cat-desc{font-size:12px;color:var(--accent);margin-top:2px}
        .settings-fixed-note{font-size:12px;color:var(--muted);font-style:italic;padding:6px 0}
        .settings-field-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px;border-top:1px solid var(--border)}
        .settings-field-label{font-size:12px;color:var(--muted);flex:1}
        .settings-field-controls{display:flex;align-items:center;gap:6px;flex-shrink:0}
        .thresh-btn{width:32px;height:32px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center}
        .thresh-btn:hover{border-color:var(--accent);color:var(--accent)}
        .thresh-input{width:64px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px;border-radius:8px;font-size:16px;font-weight:700;text-align:center;font-family:'DM Sans',sans-serif;outline:none}
        .thresh-input:focus{border-color:var(--accent)}
        .thresh-input::-webkit-outer-spin-button,.thresh-input::-webkit-inner-spin-button{-webkit-appearance:none}
        .reset-thresholds-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:10px 18px;border-radius:8px;cursor:pointer;font-size:13px;width:100%}
        .espn-btn{background:var(--accent);color:#000;border:none;padding:14px 20px;border-radius:var(--radius);font-size:14px;font-weight:700;cursor:pointer;width:100%;margin-bottom:10px}
        .espn-btn:disabled{opacity:.6;cursor:not-allowed}
        .grade-error{background:rgba(255,77,77,.1);border:1px solid var(--accent2);color:var(--accent2);border-radius:8px;padding:10px 14px;font-size:13px;margin-top:10px}
        .spinner{width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
        .approve-btn{background:var(--success);color:#000;border:none;padding:10px 18px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap}
        .rerun-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 18px;border-radius:8px;cursor:pointer;font-size:13px}
        .grade-cat-block{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px}
        .grade-cat-title{font-weight:700;font-size:13px;margin-bottom:10px;display:flex;align-items:center;gap:8px}
        .grade-threshold{font-size:11px;color:var(--muted);font-weight:400}
        .grade-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:8px;background:var(--surface2);margin-bottom:6px}
        .grade-row.flagged{border:1px solid var(--warn);background:rgba(255,179,71,.06)}
        .grade-row-left{flex:1;min-width:0}
        .grade-pick-name{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .matched-as{font-size:11px;color:var(--muted);font-weight:400}
        .conf-badge{font-size:10px;background:rgba(255,179,71,.2);color:var(--warn);padding:1px 6px;border-radius:10px}
        .grade-stats{font-size:11px;color:var(--muted);margin-top:3px}
        .flag-reason{font-size:11px;color:var(--warn);margin-top:3px}
        .override-label{font-size:11px;color:var(--accent);margin-top:2px}
        .grade-row-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
        .grade-result{font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px}
        .grade-result.pass{color:var(--success);background:rgba(60,255,138,.1)}
        .grade-result.fail{color:var(--accent2);background:rgba(255,77,77,.1)}
        .override-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:3px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}
        .override-btn:hover{border-color:var(--accent);color:var(--accent)}
        .result-row{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:8px}
        .result-cat{font-weight:600;font-size:13px;margin-bottom:10px}
        .result-picks{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
        .pick-check{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;background:var(--surface2);padding:6px 10px;border-radius:8px}
        .pick-check input{accent-color:var(--accent)}
        .no-picks-msg{font-size:12px;color:var(--muted)}
        .save-result-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:7px 16px;border-radius:8px;cursor:pointer;font-size:12px}
        .save-result-btn:hover{border-color:var(--accent);color:var(--accent)}
        .notification{position:fixed;top:70px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 20px;font-size:13px;font-weight:600;z-index:300;box-shadow:0 8px 30px rgba(0,0,0,.5);animation:slideDown .3s ease;white-space:nowrap}
        .notification.success{border-color:var(--success);color:var(--success)}
        .notification.error{border-color:var(--accent2);color:var(--accent2)}
        @keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        input::placeholder{color:var(--muted)}
      `}</style>

      {!isAuth&&(
        <div className="topbar">
          <div className="topbar-logo" onClick={()=>setView("admin")}>LAST STAND</div>
          <div className="topbar-right">
            {loggedInUser&&<span className="topbar-user"><strong>{loggedInUser.teamName}</strong></span>}
            {adminAuthed&&<button className="admin-topbar-btn" onClick={()=>setView("admin")}>⚙️ Admin</button>}
            <button className="logout-btn" onClick={logout}>Sign Out</button>
          </div>
        </div>
      )}

      {notification&&<div className={`notification ${notification.type}`}>{notification.msg}</div>}

      {isAuth
        ?<div className="auth-content">{AUTH_VIEWS[view]}</div>
        :(<>
          <div className="main-content">{VIEWS[view]}</div>
          <nav className="bottom-nav">
            {[{id:"home",icon:"🏠",label:"Home"},{id:"picks",icon:"📋",label:"Picks"},{id:"standings",icon:"🏆",label:"Standings"},{id:"categories",icon:"📊",label:"Categories"}].map(n=>(
              <button key={n.id} className={`nav-item ${view===n.id?"active":""}`} onClick={()=>setView(n.id)}>
                <span className="nav-item-icon">{n.icon}</span><span>{n.label}</span>
              </button>
            ))}
          </nav>
        </>)
      }
    </div>
  );
}
