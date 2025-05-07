document.addEventListener("DOMContentLoaded", async function () {
    document.getElementById("appInfo").textContent = `${appName} ${appVersion}`;
    const data = await getRoadmapData()
    await generateGanttChart()
    // await generateGanttChart2(data)
    await generateRoadmapTable(data)
})

async function generateGanttChart() {
    google.charts.load('current', {'packages':['gantt']});
      google.charts.setOnLoadCallback(loadData);

      function daysToMilliseconds(days) {
        return days * 24 * 60 * 60 * 1000;
      }

      function loadData() {
        $.getJSON('https://prod-15.uksouth.logic.azure.com:443/workflows/16cd74446b0c4c30bc98012e3ce3def9/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=tQwdJuzStfZRbFNLFodVz2598PhhwI0Dw9erz6oYY0I', function(response) {
          drawChart(response.data);
        });
      }

      function drawChart(jsonData) {
        var data = new google.visualization.DataTable();
        data.addColumn('string', 'Task ID');
        data.addColumn('string', 'Task Name');
        data.addColumn('string', 'Resource');
        data.addColumn('date', 'Start Date');
        data.addColumn('date', 'End Date');
        data.addColumn('number', 'Duration');
        data.addColumn('number', 'Percent Complete');
        data.addColumn('string', 'Dependencies');
        // 👇 ADD THIS:
        data.addColumn({ type: 'string', role: 'tooltip', p: { html: true } });
        jsonData.forEach(function(item, index) {
          // Parse start date
          var startDate = new Date(item.est_start_date);

          // Calculate end date
          var endDate = new Date(startDate);
          endDate.setDate(startDate.getDate() + item.task_duration);

          // Set percent complete
          var percentComplete = 0;
          if (item.completed === true) {
            percentComplete = 100;
          } else if (item.completed === false) {
            percentComplete = 0;
          } else {
            percentComplete = 0; // Not started
          }
            // 👇 Build custom HTML tooltip
            var tooltip = `
                <div style="padding:10px;">
                <strong>${item.tool} ${item.planned_version}</strong><br>
                ${item.update_description}<br>
                <em>Tool ID:</em> ${item.tool_Id}<br>
                <em>Start:</em> ${startDate.toDateString()}<br>
                <em>Duration:</em> ${item.task_duration} days
                </div>
            `;
          // Add the row
          data.addRow([
            'Task' + index,                                    // Unique Task ID
            item.tool + ' ' + item.planned_version,            // Task Name
            item.tool,                                         // Resource
            startDate,                                         // Start Date
            endDate,                                           // End Date
            null,                                              // Duration (leave null if using dates)
            percentComplete,                                   // % Complete
            null,                                               // Dependencies
            tooltip // 👈 New tooltip column here
          ]);
        });
        var rowCount = data.getNumberOfRows();
        var options = {
            height: 40*rowCount+40,
            gantt: {
              trackHeight: 40,
              barHeight: 30,
              criticalPathEnabled: true
            },
            tooltip: { isHtml: true } // 👈 Must be enabled for custom HTML tooltips
          };
          

        var chart = new google.visualization.Gantt(document.getElementById('chart_div'));
        chart.draw(data, options);
      }
}

async function generateRoadmapTable(jsonData) {
        // Sort by est_date descending
        const sortedData = jsonData.data.sort((a, b) => new Date(a.est_date) - new Date(b.est_date));

        // Populate the table
        sortedData.forEach(item => {
            $('#roadmapTable tbody').append(`
                <tr>
                    <td>${item.tool}</td>
                    <td>${item.planned_version}</td>
                    <td>${item.update_description}</td>
                    <td>${item.est_start_date}</td>
                    <td>${item.task_duration}</td>
                    <td>${item.completed === null ? 'Not Started' : (item.completed ? 'Yes' : 'No')}</td>
                </tr>
            `);
        });
    
        // Turn the table into a DataTable
        $(document).ready(function () {
            $('#roadmapTable').DataTable();
        });
}

async function getRoadmapData(){

    const headers = {
        "Content-Type": "application/json",
    };

    const requestOptions = {
        method: 'GET',
        headers: headers,
    };

    const apiUrl = "https://prod-15.uksouth.logic.azure.com:443/workflows/16cd74446b0c4c30bc98012e3ce3def9/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=tQwdJuzStfZRbFNLFodVz2598PhhwI0Dw9erz6oYY0I";
    //console.log(apiUrl)
    //console.log(requestOptions)
    responseData = await fetch(apiUrl,requestOptions)
        .then(response => response.json())
        .then(data => {
            const JSONdata = data
        //console.log(JSONdata)
        //console.log(JSONdata.uploadKey)
        //console.log(JSONdata.urls)
        return JSONdata
        })
        .catch(error => console.error('Error fetching data:', error));
    return responseData
    }